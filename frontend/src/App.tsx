import { useEffect, useRef, useState } from 'react'
import './App.css'
import {
  createPeerConnection,
  createOffer,
  createAnswerFromOffer,
  applyRemoteAnswer,
  addIceCandidate,
  closeConnections,
} from './webrtc'

type Mode = 'host' | 'join'

interface FileMetadata {
  filename: string
  filetype: string
  filesize: number
}

type ServerMessage =
  | { type: 'upload_created'; payload: { id: string } }
  | { type: 'receivers_update'; payload: Array<{ id: string; name?: string; connected_at?: string }> }
  | { type: 'webrtc_answer'; payload: { answer: RTCSessionDescriptionInit } }
  | { type: 'webrtc_ice_candidate'; payload: { candidate: RTCIceCandidateInit } }
  | { type: 'file_metadata'; payload: FileMetadata }
  | { type: 'webrtc_offer'; payload: { offer: RTCSessionDescriptionInit } }

const SIGNAL_URL = 'ws://localhost:3000'

const formatFileSize = (bytes: number) => {
  if (bytes === 0) {
    return '0 B'
  }

  if (bytes < 1_000_000) {
    return `${(bytes / 1000).toFixed(1)} KB`
  }

  return `${(bytes / 1_000_000).toFixed(2)} MB`
}

function App() {
  const [mode, setMode] = useState<Mode>('host')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadId, setUploadId] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [message, setMessage] = useState('')
  const [metadata, setMetadata] = useState<FileMetadata | null>(null)
  const [readyToSend, setReadyToSend] = useState(false)
  const [isDragActive, setIsDragActive] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const receiverIdRef = useRef<string | null>(null)
  const downloadNameRef = useRef('download')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => () => cleanup(), [])

  useEffect(() => {
    cleanup()
    setMessage('')
    setReadyToSend(false)
    setMetadata(null)
    setUploadId('')
    setJoinCode('')
    setDisplayName('')
    setSelectedFile(null)
    downloadNameRef.current = 'download'
    setIsDragActive(false)
  }, [mode])

  const cleanup = () => {
    closeConnections({ peerConnection: pcRef.current, dataChannel: channelRef.current })
    pcRef.current = null
    channelRef.current = null
    wsRef.current?.close()
    wsRef.current = null
    receiverIdRef.current = null
    setReadyToSend(false)
  }

  const assignFile = (file: File | null) => {
    setSelectedFile(file)
    setReadyToSend(false)
    setUploadId('')
    setIsDragActive(false)

    if (file) {
      downloadNameRef.current = file.name
      setMessage('Klar til at oprette en dele-kode.')
    } else {
      downloadNameRef.current = 'download'
      setMessage('')
    }
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    assignFile(file)
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0] ?? null
    assignFile(file)
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (!isDragActive) {
      setIsDragActive(true)
    }
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) {
      return
    }

    setIsDragActive(false)
  }

  const openFileDialog = () => {
    fileInputRef.current?.click()
  }

  const clearSelectedFile = () => assignFile(null)

  const startHosting = () => {
    if (!selectedFile) {
      return
    }

    cleanup()
    setMessage('Forbinder…')

    const ws = new WebSocket(
      `${SIGNAL_URL}/api/upload?filename=${encodeURIComponent(selectedFile.name)}&filetype=${encodeURIComponent(
        selectedFile.type || 'application/octet-stream',
      )}&filesize=${selectedFile.size}`,
    )
    wsRef.current = ws

    ws.onopen = () => setMessage('Delingskoden vises, så snart vi er klar.')

    ws.onmessage = async (event) => {
      const message: ServerMessage = JSON.parse(event.data)

      switch (message.type) {
        case 'upload_created':
          setUploadId(message.payload.id)
          setMessage('Del koden med modtageren, og vent på forbindelsen.')
          break
        case 'receivers_update': {
          const first = message.payload[0]
          if (!first) {
            receiverIdRef.current = null
            closeConnections({ peerConnection: pcRef.current, dataChannel: channelRef.current })
            pcRef.current = null
            channelRef.current = null
            setReadyToSend(false)
            setMessage('Afventer at nogen slutter sig til…')
            return
          }

          const previous = receiverIdRef.current
          receiverIdRef.current = first.id

          if (!pcRef.current || previous !== first.id) {
            closeConnections({ peerConnection: pcRef.current, dataChannel: channelRef.current })
            pcRef.current = null
            channelRef.current = null
            setReadyToSend(false)
            await setupHostPeerConnection()
          }
          break
        }
        case 'webrtc_answer':
          await handleAnswer(message.payload.answer)
          break
        case 'webrtc_ice_candidate':
          await handleRemoteIceCandidate(message.payload.candidate)
          break
      }
    }

    ws.onerror = () => setMessage('Forbindelsen mislykkedes. Prøv igen.')
    ws.onclose = () => setMessage('Forbindelsen er lukket.')
  }

  const joinUpload = () => {
    if (!joinCode.trim()) {
      return
    }

    cleanup()
    setMessage('Forbinder…')

    const ws = new WebSocket(`${SIGNAL_URL}/api/join/${joinCode.trim()}`)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'join_request',
          payload: { name: displayName.trim() || 'Guest' },
        }),
      )
      setMessage('Afventer afsender…')
    }

    ws.onmessage = async (event) => {
      const message: ServerMessage = JSON.parse(event.data)

      switch (message.type) {
        case 'file_metadata':
          setMetadata(message.payload)
          downloadNameRef.current = message.payload.filename
          ensureReceiverPeerConnection()
          break
        case 'webrtc_offer':
          await handleOffer(message.payload.offer)
          break
        case 'webrtc_ice_candidate':
          await handleRemoteIceCandidate(message.payload.candidate)
          break
      }
    }

    ws.onerror = () => setMessage('Kan ikke tilslutte. Tjek koden.')
    ws.onclose = () => setMessage('Forbindelsen er lukket.')
  }

  const handleIncomingData = (event: MessageEvent<Blob | ArrayBuffer | string>) => {
    const incoming = event.data

    const blob =
      incoming instanceof Blob
        ? incoming
        : incoming instanceof ArrayBuffer
        ? new Blob([incoming])
        : new Blob([incoming])

    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = downloadNameRef.current
    anchor.click()
    URL.revokeObjectURL(url)
    setMessage('Download fuldført.')
  }

  const setupHostPeerConnection = async () => {
    if (pcRef.current || !wsRef.current) {
      return
    }

    const { peerConnection, dataChannel } = createPeerConnection({
      isReceiver: false,
      onIceCandidate: (candidate: RTCIceCandidate) => {
        if (!wsRef.current) {
          return
        }

        wsRef.current.send(
          JSON.stringify({
            type: 'webrtc_ice_candidate',
            payload: {
              candidate,
              peer_id: receiverIdRef.current ?? 'receiver_id',
            },
          }),
        )
      },
      onConnectionStateChange: (state: RTCPeerConnectionState) => {
        if (state === 'disconnected' || state === 'failed') {
          setReadyToSend(false)
          if (!receiverIdRef.current) {
            setMessage('Afventer at nogen slutter sig til…')
          } else {
            setMessage('Forbindelsen er lukket.')
          }
        }
      },
      onDataChannelOpen: () => {
        setReadyToSend(true)
        setMessage('Forbindelse etableret — klar til at sende filen.')
      },
      onDataChannelClose: () => {
        setReadyToSend(false)
        if (!receiverIdRef.current) {
          setMessage('Afventer at nogen slutter sig til…')
        } else {
          setMessage('Forbindelsen er lukket.')
        }
      },
    })

    pcRef.current = peerConnection
    channelRef.current = dataChannel

    const offer = await createOffer(peerConnection)

    if (wsRef.current && receiverIdRef.current) {
      wsRef.current.send(
        JSON.stringify({
          type: 'webrtc_offer',
          payload: {
            receiver_id: receiverIdRef.current,
            offer,
          },
        }),
      )
    }
  }

  const ensureReceiverPeerConnection = () => {
    if (pcRef.current || !wsRef.current) {
      return
    }

    const { peerConnection } = createPeerConnection({
      isReceiver: true,
      onIceCandidate: (candidate: RTCIceCandidate) => {
        if (!wsRef.current) {
          return
        }

        wsRef.current.send(
          JSON.stringify({
            type: 'webrtc_ice_candidate',
            payload: {
              candidate,
              peer_id: 'host',
            },
          }),
        )
      },
      onConnectionStateChange: (state: RTCPeerConnectionState) => {
        if (state === 'disconnected' || state === 'failed') {
          setMessage('Forbindelsen er lukket.')
        }
      },
      onDataChannelMessage: handleIncomingData,
      onDataChannelOpen: () => setMessage('Modtager fil…'),
      onDataChannelClose: () => setMessage('Forbindelsen er lukket.'),
      onDataChannelCreated: (channel: RTCDataChannel) => {
        channelRef.current = channel
      },
    })

    pcRef.current = peerConnection
  }

  const handleOffer = async (offer: RTCSessionDescriptionInit) => {
    if (!pcRef.current) {
      ensureReceiverPeerConnection()
    }

    if (!pcRef.current) {
      return
    }

    const answer = await createAnswerFromOffer(pcRef.current, offer)

    wsRef.current?.send(
      JSON.stringify({
        type: 'webrtc_answer',
        payload: { answer },
      }),
    )
  }

  const handleAnswer = async (answer: RTCSessionDescriptionInit) => {
    if (!pcRef.current) {
      return
    }

    await applyRemoteAnswer(pcRef.current, answer)
  }

  const handleRemoteIceCandidate = async (candidate: RTCIceCandidateInit) => {
    if (!pcRef.current || !candidate) {
      return
    }

    try {
      await addIceCandidate(pcRef.current, candidate)
    } catch (error) {
      console.error('Failed to add ICE candidate', error)
    }
  }

  const sendFile = () => {
    if (!selectedFile || !channelRef.current || channelRef.current.readyState !== 'open') {
      setMessage('Forbindelsen er ikke klar endnu.')
      return
    }

    const reader = new FileReader()
    reader.onload = (event) => {
      const buffer = event.target?.result
      if (!buffer) {
        setMessage('Kunne ikke læse filen.')
        return
      }

      downloadNameRef.current = selectedFile.name
      channelRef.current?.send(buffer as ArrayBuffer)
      setMessage('Fil sendt.')
    }
    reader.readAsArrayBuffer(selectedFile)
  }

  return (
    <div className="App">
      <header className="hero">
        <h1>Send My Zip</h1>
        <p>Send dine filer direkte fra computer til computer. End-to-end krypteret og peer-to-peer.</p>
      </header>

      <div className="mode">
        <button className={mode === 'host' ? 'active' : ''} onClick={() => setMode('host')}>
          Send fil
        </button>
        <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>
          Modtag fil
        </button>
      </div>

      {mode === 'host' ? (
        <section className="panel host">
          <input ref={fileInputRef} type="file" onChange={handleFileChange} hidden />
          <div
            className={`dropzone ${isDragActive ? 'drag-active' : ''} ${selectedFile ? 'has-file' : ''}`}
            onClick={openFileDialog}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragEnter={() => setIsDragActive(true)}
            onDragLeave={handleDragLeave}
          >
            {!selectedFile ? (
              <div className="dropzone-empty">
                <span className="dropzone-label">Smid filer</span>
                <span className="dropzone-hint">eller klik for at vælge fra din computer</span>
              </div>
            ) : (
              <div className="dropzone-file">
                <div>
                  <span className="file-name">{selectedFile.name}</span>
                  <span className="file-detail">{selectedFile.type || 'Ukendt type'}</span>
                  <span className="file-detail">{formatFileSize(selectedFile.size)}</span>
                </div>
                <button type="button" className="link-button" onClick={clearSelectedFile}>
                  Fjern
                </button>
              </div>
            )}
          </div>

          <button onClick={startHosting} disabled={!selectedFile}>
            Opret dele-kode
          </button>

          {uploadId && (
            <div className="share">
              <span>Del denne kode</span>
              <strong>{uploadId}</strong>
            </div>
          )}

          {readyToSend && (
            <button onClick={sendFile} className="primary">
              Send fil nu
            </button>
          )}
        </section>
      ) : (
        <section className="panel receiver">
          <div className="code-entry">
            <label htmlFor="code">Har du en kode?</label>
            <div className="code-input">
              <input
                id="code"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                placeholder="fx a1b2"
              />
              <button onClick={joinUpload} disabled={!joinCode.trim()}>
                Tilslut
              </button>
            </div>
          </div>

          <label className="field">
            <span>Dit navn (valgfrit)</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Skriv dit navn" />
          </label>

          <div className="receive-card">
            <h2>Modtag fil</h2>
            <div className="receive-content">
              {metadata ? (
                <>
                  <div className="receive-meta">
                    <span className="meta-label">Navn:</span>
                    <span>{metadata.filename}</span>
                  </div>
                  <div className="receive-meta">
                    <span className="meta-label">Type:</span>
                    <span>{metadata.filetype}</span>
                  </div>
                  <div className="receive-meta">
                    <span className="meta-label">Størrelse:</span>
                    <span>{formatFileSize(metadata.filesize)}</span>
                  </div>
                </>
              ) : (
                <p className="receive-placeholder">Afventer modtagelse…</p>
              )}
            </div>
          </div>
        </section>
      )}

      {message && <p className="message">{message}</p>}
    </div>
  )
}

export default App
