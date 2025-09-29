const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

type RegisterOptions = {
  onDataChannelMessage?: (event: MessageEvent<Blob | ArrayBuffer | string>) => void
  onDataChannelOpen?: (channel: RTCDataChannel) => void
  onDataChannelClose?: () => void
  onDataChannelCreated?: (channel: RTCDataChannel) => void
}

function registerDataChannel(channel: RTCDataChannel | null, options: RegisterOptions) {
  if (!channel) {
    return
  }

  const { onDataChannelMessage, onDataChannelOpen, onDataChannelClose, onDataChannelCreated } = options

  if (onDataChannelMessage) {
    channel.onmessage = onDataChannelMessage
  }

  if (onDataChannelOpen) {
    channel.onopen = () => onDataChannelOpen(channel)
  }

  if (onDataChannelClose) {
    channel.onclose = onDataChannelClose
  }

  if (onDataChannelCreated) {
    onDataChannelCreated(channel)
  }
}

export type PeerConnectionOptions = {
  isReceiver?: boolean
  onIceCandidate?: (candidate: RTCIceCandidate) => void
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void
  onDataChannelMessage?: (event: MessageEvent<Blob | ArrayBuffer | string>) => void
  onDataChannelOpen?: (channel: RTCDataChannel) => void
  onDataChannelClose?: () => void
  onDataChannelCreated?: (channel: RTCDataChannel) => void
}

export type CloseConnectionsOptions = {
  peerConnection?: RTCPeerConnection | null
  dataChannel?: RTCDataChannel | null
}

export function createPeerConnection(options: PeerConnectionOptions = {}) {
  const {
    isReceiver = false,
    onIceCandidate,
    onConnectionStateChange,
    onIceConnectionStateChange,
    onDataChannelMessage,
    onDataChannelOpen,
    onDataChannelClose,
    onDataChannelCreated,
  } = options

  const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS })

  if (onIceCandidate) {
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        onIceCandidate(event.candidate)
      }
    }
  }

  if (onConnectionStateChange) {
    peerConnection.onconnectionstatechange = () => {
      onConnectionStateChange(peerConnection.connectionState)
    }
  }

  if (onIceConnectionStateChange) {
    peerConnection.oniceconnectionstatechange = () => {
      onIceConnectionStateChange(peerConnection.iceConnectionState)
    }
  }

  let dataChannel: RTCDataChannel | null = null

  if (isReceiver) {
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel
      registerDataChannel(dataChannel, {
        onDataChannelMessage,
        onDataChannelOpen,
        onDataChannelClose,
        onDataChannelCreated,
      })
    }
  } else {
    dataChannel = peerConnection.createDataChannel('fileTransfer')
    registerDataChannel(dataChannel, {
      onDataChannelMessage,
      onDataChannelOpen,
      onDataChannelClose,
      onDataChannelCreated,
    })
  }

  return { peerConnection, dataChannel }
}

export async function createOffer(peerConnection: RTCPeerConnection) {
  if (!peerConnection) {
    throw new Error('Peer connection is required to create an offer')
  }

  const offer = await peerConnection.createOffer()
  await peerConnection.setLocalDescription(offer)
  return offer
}

export async function createAnswerFromOffer(peerConnection: RTCPeerConnection, offer: RTCSessionDescriptionInit) {
  if (!peerConnection) {
    throw new Error('Peer connection is required to create an answer')
  }

  await peerConnection.setRemoteDescription(offer)
  const answer = await peerConnection.createAnswer()
  await peerConnection.setLocalDescription(answer)
  return answer
}

export async function applyRemoteAnswer(peerConnection: RTCPeerConnection, answer: RTCSessionDescriptionInit) {
  if (!peerConnection) {
    throw new Error('Peer connection is required to apply an answer')
  }

  await peerConnection.setRemoteDescription(answer)
}

export async function addIceCandidate(peerConnection: RTCPeerConnection, candidate: RTCIceCandidateInit) {
  if (!peerConnection || !candidate) {
    return
  }

  await peerConnection.addIceCandidate(candidate)
}

export function closeConnections({ peerConnection, dataChannel }: CloseConnectionsOptions = {}) {
  if (dataChannel && dataChannel.readyState !== 'closed') {
    try {
      dataChannel.close()
    } catch (error) {
      console.error('Failed to close data channel', error)
    }
  }

  if (peerConnection && peerConnection.connectionState !== 'closed') {
    try {
      peerConnection.close()
    } catch (error) {
      console.error('Failed to close peer connection', error)
    }
  }
}
