type WebRTCPeerConnectionOptions = {
  isReceiver?: boolean
  onIceCandidate?: (candidate: RTCIceCandidate) => void
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void
  onDataChannelMessage?: (event: MessageEvent<Blob | ArrayBuffer | string>) => void
  onDataChannelOpen?: (channel: RTCDataChannel) => void
  onDataChannelClose?: () => void
  onDataChannelCreated?: (channel: RTCDataChannel) => void
}

type CloseOptions = {
  peerConnection?: RTCPeerConnection | null
  dataChannel?: RTCDataChannel | null
}

declare module './webrtc' {
  export type PeerConnectionOptions = WebRTCPeerConnectionOptions
  export type CloseConnectionsOptions = CloseOptions
  export function createPeerConnection(options?: WebRTCPeerConnectionOptions): {
    peerConnection: RTCPeerConnection
    dataChannel: RTCDataChannel | null
  }
  export function createOffer(peerConnection: RTCPeerConnection): Promise<RTCSessionDescriptionInit>
  export function createAnswerFromOffer(
    peerConnection: RTCPeerConnection,
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit>
  export function applyRemoteAnswer(
    peerConnection: RTCPeerConnection,
    answer: RTCSessionDescriptionInit,
  ): Promise<void>
  export function addIceCandidate(
    peerConnection: RTCPeerConnection,
    candidate: RTCIceCandidateInit,
  ): Promise<void>
  export function closeConnections(options?: CloseOptions): void
}

declare module './webrtc.jsx' {
  export type PeerConnectionOptions = WebRTCPeerConnectionOptions
  export type CloseConnectionsOptions = CloseOptions
  export function createPeerConnection(options?: WebRTCPeerConnectionOptions): {
    peerConnection: RTCPeerConnection
    dataChannel: RTCDataChannel | null
  }
  export function createOffer(peerConnection: RTCPeerConnection): Promise<RTCSessionDescriptionInit>
  export function createAnswerFromOffer(
    peerConnection: RTCPeerConnection,
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit>
  export function applyRemoteAnswer(
    peerConnection: RTCPeerConnection,
    answer: RTCSessionDescriptionInit,
  ): Promise<void>
  export function addIceCandidate(
    peerConnection: RTCPeerConnection,
    candidate: RTCIceCandidateInit,
  ): Promise<void>
  export function closeConnections(options?: CloseOptions): void
}
