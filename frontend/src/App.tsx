import { useState, useRef, useEffect } from 'react'
import './App.css'

interface FileMetadata {
  filename: string
  filetype: string
  filesize: number
}

interface Receiver {
  id: string
  name: string
  connected_at: string
}

function App() {
  const [mode, setMode] = useState<'upload' | 'join'>('upload')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadId, setUploadId] = useState<string>('')
  const [joinId, setJoinId] = useState<string>('')
  const [userName, setUserName] = useState<string>('')
  const [receivers, setReceivers] = useState<Receiver[]>([])
  const [fileMetadata, setFileMetadata] = useState<FileMetadata | null>(null)
  const [status, setStatus] = useState<string>('')
  const [connectionState, setConnectionState] = useState<string>('')
  const [canSendFile, setCanSendFile] = useState<boolean>(false)

  const wsRef = useRef<WebSocket | null>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      setCanSendFile(false)
    }
  }

  const sendFile = () => {
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open' && selectedFile) {
      console.log('[DEBUG] Manually sending file:', selectedFile.name)
      const reader = new FileReader()
      reader.onload = (e) => {
        const arrayBuffer = e.target?.result as ArrayBuffer
        console.log('[DEBUG] File read completed, sending data, size:', arrayBuffer.byteLength)
        dataChannelRef.current?.send(arrayBuffer)
        console.log('[DEBUG] File data sent via data channel')
        setStatus('File sent successfully!')
      }
      reader.readAsArrayBuffer(selectedFile)
    } else {
      console.error('[DEBUG] Cannot send file - data channel not ready or no file selected')
      setStatus('Cannot send file - connection not ready')
    }
  }

  const startUpload = async () => {
    if (!selectedFile) return

    console.log('[DEBUG] Starting upload for file:', selectedFile.name, 'Size:', selectedFile.size, 'Type:', selectedFile.type)
    
    const ws = new WebSocket(`ws://localhost:3000/api/upload?filename=${encodeURIComponent(selectedFile.name)}&filetype=${encodeURIComponent(selectedFile.type)}&filesize=${selectedFile.size}`)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[DEBUG] WebSocket connection opened for upload')
      setStatus('Connected to server, waiting for upload ID...')
    }

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data)
      console.log('[DEBUG] Received WebSocket message:', message.type, message.payload)
      
      switch (message.type) {
        case 'upload_created':
          console.log('[DEBUG] Upload created with ID:', message.payload.id)
          setUploadId(message.payload.id)
          setStatus(`Upload created! Share this ID: ${message.payload.id}`)
          break
        case 'receivers_update':
          console.log('[DEBUG] Receivers updated:', message.payload)
          setReceivers(message.payload)
          break
        case 'webrtc_answer':
          console.log('[DEBUG] Received WebRTC answer')
          await handleWebRTCAnswer(message.payload)
          break
        case 'webrtc_ice_candidate':
          console.log('[DEBUG] Received WebRTC ICE candidate')
          await handleWebRTCIceCandidate(message.payload)
          break
        default:
          console.log('[DEBUG] Unknown message type:', message.type)
      }
    }

    ws.onerror = (error) => {
      console.error('[DEBUG] WebSocket error:', error)
      setStatus('WebSocket error occurred')
    }

    ws.onclose = () => {
      console.log('[DEBUG] WebSocket connection closed')
      setStatus('Disconnected from server')
    }
  }

  const joinUpload = async () => {
    if (!joinId || !userName) return

    console.log('[DEBUG] Joining upload with ID:', joinId, 'as user:', userName)
    
    const ws = new WebSocket(`ws://localhost:3000/api/join/${joinId}`)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[DEBUG] WebSocket connection opened for join')
      const joinRequest = {
        type: 'join_request',
        payload: { name: userName }
      }
      console.log('[DEBUG] Sending join request:', joinRequest)
      ws.send(JSON.stringify(joinRequest))
    }

    ws.onmessage = async (event) => {
      const message = JSON.parse(event.data)
      console.log('[DEBUG] Received WebSocket message (join):', message.type, message.payload)
      
      switch (message.type) {
        case 'file_metadata':
          console.log('[DEBUG] Received file metadata:', message.payload)
          setFileMetadata(message.payload)
          setStatus('Connected! Waiting for file transfer...')
          await createPeerConnection(true)
          break
        case 'webrtc_offer':
          console.log('[DEBUG] Received WebRTC offer')
          await handleWebRTCOffer(message.payload)
          break
        case 'webrtc_ice_candidate':
          console.log('[DEBUG] Received WebRTC ICE candidate')
          await handleWebRTCIceCandidate(message.payload)
          break
        default:
          console.log('[DEBUG] Unknown message type (join):', message.type)
      }
    }

    ws.onerror = (error) => {
      console.error('[DEBUG] WebSocket error (join):', error)
      setStatus('WebSocket error occurred while joining')
    }

    ws.onclose = () => {
      console.log('[DEBUG] WebSocket connection closed (join)')
      setStatus('Disconnected from server')
    }
  }

  const createPeerConnection = async (isReceiver: boolean = false) => {
    console.log('[DEBUG] Creating peer connection, isReceiver:', isReceiver)
    
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })
    peerConnectionRef.current = pc

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current) {
        console.log('[DEBUG] Sending ICE candidate:', event.candidate)
        wsRef.current.send(JSON.stringify({
          type: 'webrtc_ice_candidate',
          payload: {
            candidate: event.candidate,
            peer_id: isReceiver ? 'host' : 'receiver_id'
          }
        }))
      }
    }

    pc.onconnectionstatechange = () => {
      console.log('[DEBUG] Peer connection state changed:', pc.connectionState)
      setConnectionState(pc.connectionState)
    }

    pc.oniceconnectionstatechange = () => {
      console.log('[DEBUG] ICE connection state changed:', pc.iceConnectionState)
    }

    if (isReceiver) {
      pc.ondatachannel = (event) => {
        console.log('[DEBUG] Data channel received')
        const dataChannel = event.channel
        dataChannelRef.current = dataChannel
        
        dataChannel.onmessage = (event) => {
          console.log('[DEBUG] Received file data, size:', event.data.size || event.data.byteLength)
          const blob = new Blob([event.data])
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = fileMetadata?.filename || 'download'
          a.click()
          URL.revokeObjectURL(url)
          console.log('[DEBUG] File download completed')
        }

        dataChannel.onopen = () => {
          console.log('[DEBUG] Data channel opened (receiver)')
        }

        dataChannel.onclose = () => {
          console.log('[DEBUG] Data channel closed (receiver)')
        }
      }
    } else {
      const dataChannel = pc.createDataChannel('fileTransfer')
      dataChannelRef.current = dataChannel
      console.log('[DEBUG] Data channel created (sender)')

      dataChannel.onopen = () => {
        console.log('[DEBUG] Data channel opened (sender), ready to send file')
        setCanSendFile(true)
        setStatus('Connection established! You can now send the file.')
      }

      dataChannel.onclose = () => {
        console.log('[DEBUG] Data channel closed (sender)')
      }
    }

    if (!isReceiver) {
      console.log('[DEBUG] Creating WebRTC offer')
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      console.log('[DEBUG] WebRTC offer created:', offer.type)
      
      // Wait a bit for receivers to be updated, then send offer
      setTimeout(() => {
        if (receivers.length > 0 && wsRef.current) {
          console.log('[DEBUG] Sending WebRTC offer to receiver:', receivers[0].id)
          wsRef.current.send(JSON.stringify({
            type: 'webrtc_offer',
            payload: {
              receiver_id: receivers[0].id,
              offer: offer
            }
          }))
        } else {
          console.log('[DEBUG] No receivers available to send offer to')
        }
      }, 1000)
    }
  }

  const handleWebRTCOffer = async (payload: any) => {
    console.log('[DEBUG] Handling WebRTC offer')
    if (peerConnectionRef.current) {
      console.log('[DEBUG] Setting remote description from offer')
      await peerConnectionRef.current.setRemoteDescription(payload.offer)
      console.log('[DEBUG] Creating WebRTC answer')
      const answer = await peerConnectionRef.current.createAnswer()
      await peerConnectionRef.current.setLocalDescription(answer)
      console.log('[DEBUG] WebRTC answer created and set locally')
      
      if (wsRef.current) {
        console.log('[DEBUG] Sending WebRTC answer')
        wsRef.current.send(JSON.stringify({
          type: 'webrtc_answer',
          payload: {
            answer: answer
          }
        }))
      }
    } else {
      console.error('[DEBUG] No peer connection available to handle offer')
    }
  }

  const handleWebRTCAnswer = async (payload: any) => {
    console.log('[DEBUG] Handling WebRTC answer')
    if (peerConnectionRef.current) {
      console.log('[DEBUG] Setting remote description from answer')
      await peerConnectionRef.current.setRemoteDescription(payload.answer)
      console.log('[DEBUG] WebRTC answer processed successfully')
    } else {
      console.error('[DEBUG] No peer connection available to handle answer')
    }
  }

  const handleWebRTCIceCandidate = async (payload: any) => {
    if (peerConnectionRef.current && payload.candidate) {
      console.log('[DEBUG] Adding ICE candidate')
      await peerConnectionRef.current.addIceCandidate(payload.candidate)
      console.log('[DEBUG] ICE candidate added successfully')
    } else {
      console.error('[DEBUG] Cannot add ICE candidate - no peer connection or candidate')
    }
  }

  useEffect(() => {
    console.log('[DEBUG] Component mounted')
    return () => {
      console.log('[DEBUG] Component unmounting, cleaning up connections')
      cleanupConnections()
    }
  }, [])

  const cleanupConnections = () => {
    if (wsRef.current) {
      console.log('[DEBUG] Closing WebSocket connection')
      wsRef.current.close()
      wsRef.current = null
    }
    if (peerConnectionRef.current) {
      console.log('[DEBUG] Closing peer connection')
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }
    setCanSendFile(false)
    setConnectionState('')
  }

  useEffect(() => {
    if (mode === 'upload' && receivers.length > 0 && !peerConnectionRef.current && uploadId) {
      console.log('[DEBUG] Receiver detected, creating peer connection for file transfer')
      createPeerConnection(false)
    }
  }, [receivers, mode, uploadId])

  return (
    <div className="App">
      <h1>SendMyZip - File Sharing</h1>
      
      <div className="mode-selector">
        <button 
          className={mode === 'upload' ? 'active' : ''}
          onClick={() => {
            cleanupConnections()
            setMode('upload')
            setSelectedFile(null)
            setUploadId('')
            setReceivers([])
            setStatus('')
          }}
        >
          Upload File
        </button>
        <button 
          className={mode === 'join' ? 'active' : ''}
          onClick={() => {
            cleanupConnections()
            setMode('join')
            setJoinId('')
            setUserName('')
            setFileMetadata(null)
            setStatus('')
          }}
        >
          Join Upload
        </button>
      </div>

      {mode === 'upload' && (
        <div className="upload-section">
          <div className="file-input">
            <input type="file" onChange={handleFileSelect} />
            {selectedFile && (
              <div className="file-info">
                <p><strong>File:</strong> {selectedFile.name}</p>
                <p><strong>Size:</strong> {(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                <p><strong>Type:</strong> {selectedFile.type}</p>
              </div>
            )}
          </div>
          
          <button 
            onClick={startUpload}
            disabled={!selectedFile}
          >
            Start Upload
          </button>

          {uploadId && (
            <div className="upload-info">
              <h3>Share this ID:</h3>
              <div className="share-id">{uploadId}</div>
              <p>Connected receivers: {receivers.length}</p>
              {connectionState && (
                <p><strong>Connection state:</strong> {connectionState}</p>
              )}
              {canSendFile && (
                <button 
                  className="send-button"
                  onClick={sendFile}
                  disabled={!selectedFile}
                >
                  Send File
                </button>
              )}
              {receivers.length > 0 && (
                <div className="receivers-list">
                  {receivers.map(receiver => (
                    <div key={receiver.id} className="receiver">
                      {receiver.name} - connected at {new Date(receiver.connected_at).toLocaleTimeString()}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'join' && (
        <div className="join-section">
          <div className="join-input">
            <input
              type="text"
              placeholder="Enter upload ID"
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
            />
            <input
              type="text"
              placeholder="Enter your name"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
            />
          </div>
          
          <button 
            onClick={joinUpload}
            disabled={!joinId || !userName}
          >
            Join Upload
          </button>

          {fileMetadata && (
            <div className="file-info">
              <h3>File Information:</h3>
              <p><strong>Name:</strong> {fileMetadata.filename}</p>
              <p><strong>Size:</strong> {(fileMetadata.filesize / 1024 / 1024).toFixed(2)} MB</p>
              <p><strong>Type:</strong> {fileMetadata.filetype}</p>
              {connectionState && (
                <p><strong>Connection state:</strong> {connectionState}</p>
              )}
              <p>The file download will start automatically once the connection is established.</p>
            </div>
          )}
        </div>
      )}

      {status && (
        <div className="status">
          <p>{status}</p>
        </div>
      )}
    </div>
  )
}

export default App
