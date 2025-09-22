package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
)

type Receiver struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"` // self-chosen name to display to the host
	PublicKey   string          `json:"public_key"`
	Conn        *websocket.Conn `json:"-"`
	ConnectedAt time.Time       `json:"connected_at"`
}

type Metadata struct {
	FileName string `json:"filename"`
	FileType string `json:"filetype"`
	FileSize int64  `json:"filesize"`
}

type Upload struct {
	ID        string          `json:"id"`
	Host      *websocket.Conn `json:"-"`
	Meta      Metadata        `json:"metadata"`
	Receivers []*Receiver     `json:"receivers"`
	CreatedAt time.Time       `json:"created_at"`
	mutex     sync.RWMutex
}

type Message struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

type JoinRequest struct {
	Name      string `json:"name"`
	PublicKey string `json:"public_key"`
}

type WebRTCSignalingMessage struct {
	Type       string `json:"type"`
	SenderID   string `json:"sender_id,omitempty"`
	ReceiverID string `json:"receiver_id,omitempty"`
	PeerID     string `json:"peer_id,omitempty"`
	Offer      any    `json:"offer,omitempty"`
	Answer     any    `json:"answer,omitempty"`
	Candidate  any    `json:"candidate,omitempty"`
}

var (
	uploads      = make(map[string]*Upload) // ID:*Upload
	uploadsMutex sync.RWMutex
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now
	},
}

func generateID() string {
	bytes := make([]byte, 4)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func generateReceiverID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func handleNewFileUpload(w http.ResponseWriter, r *http.Request) {
	// Parse metadata from query parameters
	meta := &Metadata{
		FileName: r.URL.Query().Get("filename"),
		FileType: r.URL.Query().Get("filetype"),
	}

	filesizeStr := r.URL.Query().Get("filesize")
	if meta.FileName == "" || meta.FileType == "" || filesizeStr == "" {
		http.Error(w, "Missing required query parameters: filename, filetype, filesize", http.StatusBadRequest)
		return
	}

	var err error
	meta.FileSize, err = strconv.ParseInt(filesizeStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid filesize parameter", http.StatusBadRequest)
		return
	}

	// Generate unique upload ID
	uploadID := generateID()

	// Upgrade to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade connection: %v", err)
		http.Error(w, "Could not upgrade connection", http.StatusBadRequest)
		return
	}

	// Create upload session
	upload := &Upload{
		ID:        uploadID,
		Host:      conn,
		Meta:      *meta,
		Receivers: make([]*Receiver, 0),
		CreatedAt: time.Now(),
	}

	uploadsMutex.Lock()
	uploads[uploadID] = upload
	uploadsMutex.Unlock()

	// Send upload ID to host
	response := Message{
		Type:    "upload_created",
		Payload: map[string]string{"id": uploadID},
	}
	conn.WriteJSON(response)

	log.Printf("Created new upload session: %s for file: %s (%d bytes)", uploadID, meta.FileName, meta.FileSize)

	// Handle host messages
	go handleHostConnection(upload)
}

func handleHostConnection(upload *Upload) {
	defer func() {
		upload.Host.Close()
		uploadsMutex.Lock()
		delete(uploads, upload.ID)
		uploadsMutex.Unlock()
	}()

	for {
		var msg Message
		err := upload.Host.ReadJSON(&msg)
		if err != nil {
			log.Printf("Host connection error: %v", err)
			break
		}

		switch msg.Type {
		case "get_receivers":
			sendReceiversUpdate(upload)
		case "webrtc_offer":
			handleWebRTCSignaling(upload, msg, true)
		case "webrtc_answer":
			handleWebRTCSignaling(upload, msg, true)
		case "webrtc_ice_candidate":
			handleWebRTCSignaling(upload, msg, true)
		default:
			// Unknown message type
		}
	}
}

func handleJoinUpload(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	uploadID := vars["id"]

	uploadsMutex.RLock()
	upload, exists := uploads[uploadID]
	uploadsMutex.RUnlock()

	if !exists {
		http.Error(w, "Upload not found", http.StatusNotFound)
		return
	}

	// Upgrade to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade receiver connection: %v", err)
		http.Error(w, "Could not upgrade connection", http.StatusBadRequest)
		return
	}

	// Handle receiver connection
	go handleReceiverConnection(upload, conn)
}

func handleReceiverConnection(upload *Upload, conn *websocket.Conn) {
	defer conn.Close()

	// Wait for join request
	var msg Message
	err := conn.ReadJSON(&msg)
	if err != nil {
		log.Printf("Failed to read join message: %v", err)
		return
	}

	if msg.Type != "join_request" {
		log.Printf("Expected join_request, got: %s", msg.Type)
		return
	}

	var joinReq JoinRequest
	data, _ := json.Marshal(msg.Payload)
	json.Unmarshal(data, &joinReq)

	// Create receiver
	receiver := &Receiver{
		ID:          generateReceiverID(),
		Name:        joinReq.Name,
		PublicKey:   joinReq.PublicKey,
		Conn:        conn,
		ConnectedAt: time.Now(),
	}

	// Add receiver to upload
	upload.mutex.Lock()
	upload.Receivers = append(upload.Receivers, receiver)
	upload.mutex.Unlock()

	log.Printf("Receiver %s (%s) joined upload %s", receiver.Name, receiver.ID, upload.ID)

	// Send file metadata to receiver
	metaMsg := Message{
		Type:    "file_metadata",
		Payload: upload.Meta,
	}
	conn.WriteJSON(metaMsg)

	// Notify host about new receiver
	sendReceiversUpdate(upload)

	// Handle receiver messages
	for {
		var receiverMsg Message
		err := conn.ReadJSON(&receiverMsg)
		if err != nil {
			log.Printf("Receiver connection error: %v", err)
			break
		}

		log.Printf("Received message from receiver %s: type=%s", receiver.Name, receiverMsg.Type)

		// Handle WebRTC signaling messages from receiver
		switch receiverMsg.Type {
		case "webrtc_answer":
			log.Printf("Received WebRTC answer from receiver")
			// Add receiver ID to the message payload
			if payload, ok := receiverMsg.Payload.(map[string]any); ok {
				payload["sender_id"] = receiver.ID
				receiverMsg.Payload = payload
			}
			handleWebRTCSignaling(upload, receiverMsg, false)
		case "webrtc_ice_candidate":
			log.Printf("Received WebRTC ICE candidate from receiver")
			// Add receiver ID to the message payload
			if payload, ok := receiverMsg.Payload.(map[string]any); ok {
				payload["peer_id"] = receiver.ID
				receiverMsg.Payload = payload
			}
			handleWebRTCSignaling(upload, receiverMsg, false)
		default:
			log.Printf("Unknown message type from receiver %s: %s", receiver.Name, receiverMsg.Type)
		}
	}

	// Remove receiver when disconnected
	upload.mutex.Lock()
	for i, r := range upload.Receivers {
		if r.ID == receiver.ID {
			upload.Receivers = append(upload.Receivers[:i], upload.Receivers[i+1:]...)
			break
		}
	}
	upload.mutex.Unlock()

	// Notify host about receiver leaving
	sendReceiversUpdate(upload)
	log.Printf("Receiver %s disconnected from upload %s", receiver.Name, upload.ID)
}

func sendReceiversUpdate(upload *Upload) {
	upload.mutex.RLock()
	receivers := make([]*Receiver, len(upload.Receivers))
	copy(receivers, upload.Receivers)
	upload.mutex.RUnlock()

	// Create safe receiver list (without connection objects)
	safeReceivers := make([]map[string]any, len(receivers))
	for i, r := range receivers {
		safeReceivers[i] = map[string]any{
			"id":           r.ID,
			"name":         r.Name,
			"public_key":   r.PublicKey,
			"connected_at": r.ConnectedAt,
		}
	}

	msg := Message{
		Type:    "receivers_update",
		Payload: safeReceivers,
	}

	upload.Host.WriteJSON(msg)
}

func handleWebRTCSignaling(upload *Upload, msg Message, isFromHost bool) {
	var signalingMsg WebRTCSignalingMessage
	data, _ := json.Marshal(msg.Payload)
	json.Unmarshal(data, &signalingMsg)

	switch msg.Type {
	case "webrtc_offer":
		// Forward offer from host to receiver
		if isFromHost {
			upload.mutex.RLock()
			var targetReceiver *Receiver
			for _, receiver := range upload.Receivers {
				if receiver.ID == signalingMsg.ReceiverID {
					targetReceiver = receiver
					break
				}
			}
			upload.mutex.RUnlock()

			if targetReceiver != nil {
				offerMsg := Message{
					Type: "webrtc_offer",
					Payload: map[string]any{
						"sender_id": "host",
						"offer":     signalingMsg.Offer,
					},
				}
				err := targetReceiver.Conn.WriteJSON(offerMsg)
				if err != nil {
					log.Printf("Failed to send WebRTC offer: %v", err)
				}
			}
		}

	case "webrtc_answer":
		// Forward answer from receiver to host
		if !isFromHost {
			answerMsg := Message{
				Type: "webrtc_answer",
				Payload: map[string]any{
					"receiver_id": signalingMsg.SenderID,
					"answer":      signalingMsg.Answer,
				},
			}
			upload.Host.WriteJSON(answerMsg)
		}

	case "webrtc_ice_candidate":
		// Forward ICE candidates between host and receiver
		if isFromHost {
			// From host to receiver
			upload.mutex.RLock()
			var targetReceiver *Receiver
			for _, receiver := range upload.Receivers {
				if receiver.ID == signalingMsg.PeerID {
					targetReceiver = receiver
					break
				}
			}
			upload.mutex.RUnlock()

			if targetReceiver != nil {
				candidateMsg := Message{
					Type: "webrtc_ice_candidate",
					Payload: map[string]any{
						"peer_id":   "host",
						"candidate": signalingMsg.Candidate,
					},
				}
				targetReceiver.Conn.WriteJSON(candidateMsg)
							}
		} else {
			// From receiver to host
			candidateMsg := Message{
				Type: "webrtc_ice_candidate",
				Payload: map[string]any{
					"peer_id":   signalingMsg.PeerID,
					"candidate": signalingMsg.Candidate,
				},
			}
			upload.Host.WriteJSON(candidateMsg)
			log.Printf("Forwarded ICE candidate from receiver to host")
		}
	}
}

func main() {
	router := mux.NewRouter()

	staticDir := flag.String("static", "/app/dist", "Path to static files directory")

	flag.Parse()
	fmt.Println("Static files directory:", *staticDir)

	// API routes first
	api := router.PathPrefix("/api").Subrouter()
	// API routes
	api.HandleFunc("/upload", handleNewFileUpload).Methods("GET")
	api.HandleFunc("/join/{id}", handleJoinUpload).Methods("GET")

	fmt.Println("QuickFS API server starting on :3000")
	log.Fatal(http.ListenAndServe(":3000", router))
}
