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

function App() {
  const [mode, setMode] = useState<Mode>('host')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadId, setUploadId] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [message, setMessage] = useState('')
  const [metadata, setMetadata] = useState<FileMetadata | null>(null)
  const [readyToSend, setReadyToSend] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const receiverIdRef = useRef<string | null>(null)
  const downloadNameRef = useRef('download')

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

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setSelectedFile(file)
    setReadyToSend(false)
    if (file) {
      downloadNameRef.current = file.name
    } else {
      downloadNameRef.current = 'download'
    }
  }

  const startHosting = () => {
    if (!selectedFile) {
      return
    }

    cleanup()
    setMessage('Connecting…')

    const ws = new WebSocket(
      `${SIGNAL_URL}/api/upload?filename=${encodeURIComponent(selectedFile.name)}&filetype=${encodeURIComponent(
        selectedFile.type || 'application/octet-stream',
      )}&filesize=${selectedFile.size}`,
    )
    wsRef.current = ws

    ws.onopen = () => setMessage('Share code will appear once ready.')

    ws.onmessage = async (event) => {
      const message: ServerMessage = JSON.parse(event.data)

      switch (message.type) {
        case 'upload_created':
          setUploadId(message.payload.id)
          setMessage('Share this code with the receiver.')
          break
        case 'receivers_update': {
          const first = message.payload[0]
          if (!first) {
            receiverIdRef.current = null
            closeConnections({ peerConnection: pcRef.current, dataChannel: channelRef.current })
            pcRef.current = null
            channelRef.current = null
            setReadyToSend(false)
            setMessage('Waiting for someone to join…')
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

    ws.onerror = () => setMessage('Connection failed. Try again.')
    ws.onclose = () => setMessage('Connection closed.')
  }

  const joinUpload = () => {
    if (!joinCode.trim()) {
      return
    }

    cleanup()
    setMessage('Connecting…')

    const ws = new WebSocket(`${SIGNAL_URL}/api/join/${joinCode.trim()}`)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'join_request',
          payload: { name: displayName.trim() || 'Guest' },
        }),
      )
      setMessage('Waiting for the sender…')
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

    ws.onerror = () => setMessage('Unable to join. Check the code.')
    ws.onclose = () => setMessage('Connection closed.')
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
    setMessage('Download complete.')
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
          setMessage('Connection closed.')
        }
      },
      onDataChannelOpen: () => {
        setReadyToSend(true)
        setMessage('Ready to send the file.')
      },
      onDataChannelClose: () => {
        setReadyToSend(false)
        setMessage('Connection closed.')
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
          setMessage('Connection closed.')
        }
      },
      onDataChannelMessage: handleIncomingData,
      onDataChannelOpen: () => setMessage('Receiving file…'),
      onDataChannelClose: () => setMessage('Connection closed.'),
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
      setMessage('Connection not ready.')
      return
    }

    const reader = new FileReader()
    reader.onload = (event) => {
      const buffer = event.target?.result
      if (!buffer) {
        setMessage('Unable to read file.')
        return
      }

      downloadNameRef.current = selectedFile.name
      channelRef.current?.send(buffer as ArrayBuffer)
      setMessage('File sent.')
    }
    reader.readAsArrayBuffer(selectedFile)
  }

  return (
    <div className="App">
      <h1>SendMyZip</h1>

      <div className="mode">
        <button className={mode === 'host' ? 'active' : ''} onClick={() => setMode('host')}>
          Send
        </button>
        <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>
          Receive
        </button>
      </div>

      {mode === 'host' ? (
        <section className="panel">
          <label className="field">
            <span>Choose a file</span>
            <input type="file" onChange={handleFileChange} />
          </label>

          <button onClick={startHosting} disabled={!selectedFile}>
            Create share code
          </button>

          {uploadId && (
            <div className="share">
              <span>Share code</span>
              <strong>{uploadId}</strong>
            </div>
          )}

          {readyToSend && (
            <button onClick={sendFile} className="primary">
              Send file now
            </button>
          )}
        </section>
      ) : (
        <section className="panel">
          <label className="field">
            <span>Share code</span>
            <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="e.g. a1b2" />
          </label>

          <label className="field">
            <span>Name (optional)</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>

          <button onClick={joinUpload} disabled={!joinCode.trim()}>
            Join
          </button>

          {metadata && (
            <div className="share">
              <span>Incoming file</span>
              <strong>{metadata.filename}</strong>
            </div>
          )}
        </section>
      )}

      {message && <p className="message">{message}</p>}
    </div>
  )
}

export default App
