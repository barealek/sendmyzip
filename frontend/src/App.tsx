import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import {
  createPeerConnection,
  createOffer,
  createAnswerFromOffer,
  applyRemoteAnswer,
  addIceCandidate,
  closeConnections,
} from './webrtc'
import * as QRCode from 'qrcode'

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

const SIGNAL_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadId, setUploadId] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [message, setMessage] = useState('')
  const [metadata, setMetadata] = useState<FileMetadata | null>(null)
  const [readyToSend, setReadyToSend] = useState(false)
  const [isDragActive, setIsDragActive] = useState(false)
  const [showReceiverMode, setShowReceiverMode] = useState(false)
  const [isHosting, setIsHosting] = useState(false)
  const [receiverStatus, setReceiverStatus] = useState<'idle' | 'connecting' | 'connected'>('idle')
  const [shareLink, setShareLink] = useState('')
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('')
  const [receiverName, setReceiverName] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const receiverIdRef = useRef<string | null>(null)
  const downloadNameRef = useRef('download')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const autoJoinHandledRef = useRef(false)

  const cleanup = useCallback(() => {
    closeConnections({ peerConnection: pcRef.current, dataChannel: channelRef.current })
    pcRef.current = null
    channelRef.current = null
    wsRef.current?.close()
    wsRef.current = null
    receiverIdRef.current = null
    setReadyToSend(false)
    setIsHosting(false)
    setShowReceiverMode(false)
    setMetadata(null)
    setReceiverStatus('idle')
    setShareLink('')
    setQrCodeDataUrl('')
  }, [])

  useEffect(() => () => cleanup(), [cleanup])

  const assignFile = (file: File | null) => {
    cleanup()
    setUploadId('')
    setJoinCode('')
    setSelectedFile(null)
    setIsDragActive(false)

    if (file) {
      setSelectedFile(file)
      downloadNameRef.current = file.name
      startHosting(file)
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

  const startHosting = (file: File) => {
    setMetadata(null)
    setMessage('Forbinder…')
    setIsHosting(true)

    const ws = new WebSocket(
      `${SIGNAL_URL}/api/upload?filename=${encodeURIComponent(file.name)}&filetype=${encodeURIComponent(
        file.type || 'application/octet-stream',
      )}&filesize=${file.size}`,
    )
    wsRef.current = ws

    ws.onopen = () => setMessage('Delingskoden vises, så snart vi er klar.')

    ws.onmessage = async (event) => {
      const message: ServerMessage = JSON.parse(event.data)

      switch (message.type) {
        case 'upload_created': {
          const url = `${window.location.origin}/?code=${message.payload.id}`
          setUploadId(message.payload.id)
          setShareLink(url)
          try {
            const dataUrl = await QRCode.toDataURL(url)
            setQrCodeDataUrl(dataUrl)
          } catch (error) {
            console.error('Failed to create QR code', error)
            setQrCodeDataUrl('')
          }
          setMessage('Del koden eller QR-koden med modtageren, og vent på forbindelsen.')
          break
        }
        case 'receivers_update': {
          const first = message.payload[0]
          if (!first || !first.id) {
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

    ws.onerror = () => {
      if (wsRef.current === ws) {
        setIsHosting(false)
        setReadyToSend(false)
        setMessage('Forbindelsen mislykkedes. Prøv igen.')
      }
    }
    ws.onclose = () => {
      if (wsRef.current === ws) {
        setIsHosting(false)
        setReadyToSend(false)
        setMessage('Forbindelsen er lukket.')
      }
    }
  }

  const handleIncomingData = useCallback((event: MessageEvent<Blob | ArrayBuffer | string>) => {
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
  }, [])

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

  const ensureReceiverPeerConnection = useCallback(() => {
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
          setReceiverStatus('idle')
          setShowReceiverMode(false)
          setMessage('Forbindelsen er lukket.')
        }
      },
      onDataChannelMessage: handleIncomingData,
      onDataChannelOpen: () => {
        setReceiverStatus('connected')
        setMessage('Modtager fil…')
      },
      onDataChannelClose: () => {
        setReceiverStatus('idle')
        setShowReceiverMode(false)
        setMetadata(null)
        setMessage('Forbindelsen er lukket.')
      },
      onDataChannelCreated: (channel: RTCDataChannel) => {
        channelRef.current = channel
      },
    })

    setReceiverStatus('connecting')

    pcRef.current = peerConnection
  }, [handleIncomingData])

  const handleOffer = useCallback(
    async (offer: RTCSessionDescriptionInit) => {
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
    },
    [ensureReceiverPeerConnection],
  )

  const handleAnswer = useCallback(async (answer: RTCSessionDescriptionInit) => {
    if (!pcRef.current) {
      return
    }

    await applyRemoteAnswer(pcRef.current, answer)
  }, [])

  const handleRemoteIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    if (!pcRef.current || !candidate) {
      return
    }

    try {
      await addIceCandidate(pcRef.current, candidate)
    } catch (error) {
      console.error('Failed to add ICE candidate', error)
    }
  }, [])

  const joinUpload = useCallback(
    (codeOverride?: string) => {
      const codeSource = codeOverride ?? joinCode
      const trimmedCode = codeSource.trim()
      if (!trimmedCode) {
        return
      }

      cleanup()
      setSelectedFile(null)
      setUploadId('')
      setIsDragActive(false)
      setJoinCode(trimmedCode)
      setMessage('Forbinder…')
      setShowReceiverMode(true)
      setReceiverStatus('connecting')

      const ws = new WebSocket(`${SIGNAL_URL}/api/join/${trimmedCode}`)
      wsRef.current = ws

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'join_request',
            payload: { name: receiverName.trim() || 'Guest' },
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

      ws.onerror = () => {
        if (wsRef.current === ws) {
          setReceiverStatus('idle')
          setShowReceiverMode(false)
          setMessage('Kan ikke tilslutte. Tjek koden.')
        }
      }
      ws.onclose = () => {
        if (wsRef.current === ws) {
          setReceiverStatus('idle')
          setShowReceiverMode(false)
          setMessage('Forbindelsen er lukket.')
        }
      }
    },
    [cleanup, ensureReceiverPeerConnection, handleOffer, handleRemoteIceCandidate, joinCode],
  )

  const handleJoinKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      joinUpload()
    }
  }

  useEffect(() => {
    if (autoJoinHandledRef.current) {
      return
    }

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code) {
      if (code) {
        autoJoinHandledRef.current = true
        setJoinCode(code)
        joinUpload(code)
      }
    }
  }, [joinUpload])

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
      <div className="window-chrome" aria-hidden>
        <span className="dot red" />
        <span className="dot yellow" />
        <span className="dot green" />
      </div>

      <header className="hero">
        <h1>Send My Zip</h1>
        <p>Send dine filer direkte fra computer til computer. End-to-end krypteret og peer-to-peer.</p>
      </header>

      {!showReceiverMode && (
        <section className="drop-section">
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
                <span className="dropzone-label">Smid zip</span>
                <span className="dropzone-hint">eller klik for at vælge fra din computer</span>
              </div>
            ) : (
              <div className="dropzone-file">
                <div className="file-summary">
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

          {(uploadId || readyToSend) && (
            <div className="host-actions">
              {uploadId && (
                <div className="share-code">
                  <span>Del denne kode</span>
                  <strong>{uploadId}</strong>
                  {shareLink && (
                    <a
                      href={shareLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="share-link"
                    >
                      {shareLink}
                    </a>
                  )}
                  {qrCodeDataUrl && (
                    <div className="qr-wrapper">
                      <img src={qrCodeDataUrl} alt={`QR kode for ${uploadId}`} />
                      <a href={qrCodeDataUrl} download={`sendmyzip-${uploadId}.png`} className="qr-download">
                        Download QR
                      </a>
                    </div>
                  )}
                </div>
              )}

              {readyToSend && (
                <button onClick={sendFile} className="primary">
                  Send fil nu
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {!isHosting && (
        <section className="join-section">
          <label htmlFor="code-input" className="join-label">
            Har du en kode?
          </label>
          <div className="code-entry">
            <input
              id="code-input"
              value={joinCode}
              onChange={(event) => {
                const value = event.target.value
                setJoinCode(value)
                const trimmed = value.trim()

                if (showReceiverMode) {
                  cleanup()
                  setMessage('')
                }

                if (!trimmed) {
                  setMetadata(null)
                  setReceiverStatus('idle')
                  downloadNameRef.current = 'download'
                  setMessage('')
                }
              }}
              onKeyDown={handleJoinKeyDown}
              placeholder="fx a1b2"
            />
            <button
              type="button"
              className="code-submit"
              onClick={() => joinUpload()}
              disabled={!joinCode.trim()}
            >
              ➜
            </button>
          </div>
          
          <div className="name-entry">
            <label htmlFor="name-input" className="name-label">
              Dit navn (valgfrit):
            </label>
            <input
              id="name-input"
              value={receiverName}
              onChange={(event) => setReceiverName(event.target.value)}
              placeholder="Dit navn"
              maxLength={50}
            />
          </div>

          {showReceiverMode && (
            <div className="receive-card">
              <h2>Modtager fil</h2>
              {receiverStatus !== 'idle' && (
                <div className="receive-status">
                  <span className={`pulse-dot ${receiverStatus}`} />
                  <span>{receiverStatus === 'connected' ? 'Forbundet — klar til download.' : 'Forbinder…'}</span>
                </div>
              )}
              {metadata ? (
                <div className="receive-meta-list">
                  <div className="receive-row">
                    <span className="meta-label">Navn</span>
                    <span>{metadata.filename}</span>
                  </div>
                  <div className="receive-row">
                    <span className="meta-label">Type</span>
                    <span>{metadata.filetype}</span>
                  </div>
                  <div className="receive-row">
                    <span className="meta-label">Størrelse</span>
                    <span>{formatFileSize(metadata.filesize)}</span>
                  </div>
                </div>
              ) : (
                receiverStatus === 'connecting' && (
                  <div className="receive-placeholder">
                    <span>Venter på filinfo…</span>
                  </div>
                )
              )}
            </div>
          )}
        </section>
      )}

      {message && <p className="message">{message}</p>}
    </div>
  )
}

export default App
