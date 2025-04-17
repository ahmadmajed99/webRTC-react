import React, { useEffect, useRef, useState } from "react";

const WebRTCRoom = () => {
  const [roomId, setRoomId] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const localStreamRef = useRef(null);  
  const [pcs, setPcs] = useState({});
  const [remoteStreams, setRemoteStreams] = useState({});
  const wsRef = useRef(null);
  const streamReady = useRef(false);
  const messageQueue = useRef([]);
  const localVideoRef = useRef(null);
  const pendingPeersRef = useRef([]);
  const pendingCandidatesRef = useRef({});
  const remoteVideoRefs = useRef({});

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (localStream) {
      streamReady.current = true;
      messageQueue.current.forEach((msg) => handleSignalingMessage(msg));
      messageQueue.current = [];
    }
  }, [localStream]);
  

  useEffect(() => {
    if (localStream && pendingPeersRef.current.length > 0) {
      console.log("🎬 localStream ready, processing pending offers...");
      pendingPeersRef.current.forEach(async (id) => {
        await createAndSendOffer(id);
      });
      pendingPeersRef.current = [];
    }
  }, [localStream]);
  

  const createWebSocket = (room) => {
    const ws = new WebSocket(`wss://webtrtc.onrender.com`);
    ws.onopen = () => {
      console.log("🟢 WebSocket connected");
  
      // 👇 Send join message here
      ws.send(JSON.stringify({
        type: "join",
        room: room,
      }));
    };
  
    ws.onclose = () => console.log("🔴 WebSocket disconnected");
  
    ws.onmessage = async (msg) => {
      const data = JSON.parse(msg.data);
      if (!streamReady.current) {
        messageQueue.current.push(data);
        return;
      }
  
      await handleSignalingMessage(data);
    };
  
    wsRef.current = ws;
  };

  const handleSignalingMessage = async (data) => {
    switch (data.type) {
      case "init":
        wsRef.current.id = data.id;
        break;
      case "offer":
        await handleOffer(data);
        break;
      case "answer":
        await handleAnswer(data);
        break;  
      case "candidate":
        await handleCandidate(data);
        break;
        case "join":
          if (data.id !== wsRef.current.id) {
            pendingPeersRef.current.push(data.id);
            if (localStreamRef.current) {
              pendingPeersRef.current.forEach(async (id) => {
                await createAndSendOffer(id);
              });
              pendingPeersRef.current = [];
            }
          }
          break;
          case "new-peer":
            if (data.id !== wsRef.current.id) {
              pendingPeersRef.current.push(data.id);
              if (localStreamRef.current) {
                await createAndSendOffer(data.id);
                pendingPeersRef.current = pendingPeersRef.current.filter(peerId => peerId !== data.id);
              }
            }
          break;
      case "bye":
        if (pcs[data.sender]) {
          pcs[data.sender].close();
          const newPcs = { ...pcs };
          delete newPcs[data.sender];
          setPcs(newPcs);
        }
        break;
      default:
        break;
    }
  };

  const sendMessage = (msg) => {
    wsRef.current.send(JSON.stringify(msg));
  };

  const createPeerConnection = (id, stream) => {
    const pc = new RTCPeerConnection();
  
    stream?.getTracks().forEach((track) => pc.addTrack(track, stream));
  
    pcs[id] = pc;
  
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendMessage({
          type: "candidate",
          candidate: e.candidate,
          target: id,
          sender: wsRef.current.id,
        });
      }
    };
  
    pc.ontrack = (e) => {
      console.log("📡 Received track:", e.track.kind);
    
      setRemoteStreams((prev) => {
        const existingStream = prev[id];
    
        if (existingStream) {
          // Clone and update the existing stream
          const updatedStream = new MediaStream(existingStream);
          updatedStream.addTrack(e.track);
    
          const updated = { ...prev, [id]: updatedStream };
          return updated;
        } else {
          // First time we see a track from this peer
          const newStream = new MediaStream();
          newStream.addTrack(e.track);
    
          const updated = { ...prev, [id]: newStream };
          return updated;
        }
      });
    };
    
    return pc;
  };
  

  const createAndSendOffer = async (targetId) => {
    const stream = localStreamRef.current;
  
    const pc = createPeerConnection(targetId, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    setPcs((prev) => ({ ...prev, [targetId]: pc }));
    sendMessage({
      type: "offer",
      offer,
      target: targetId,
      sender: wsRef.current.id,
    });
  };

// compare IDs to decide who is polite

const handleOffer = async ({ offer, sender }) => {
  let pc = pcs[sender];

  if (!pc) {
    const stream = localStreamRef.current;
    pc = createPeerConnection(sender, stream);
    setPcs((prev) => ({ ...prev, [sender]: pc }));
  }

  const isPolite = wsRef.current.id > sender;
  const offerDesc = new RTCSessionDescription(offer);

  if (pc.signalingState !== "stable") {
    if (!isPolite) {
      console.warn("⚠️ Glare detected and I'm impolite. Ignoring offer.");
      return;
    }

    try {
      await pc.setLocalDescription({ type: "rollback" });
      console.log("🔁 Rolled back local description");
    } catch (e) {
      console.error("❌ Failed to rollback:", e);
      return;
    }
  }

  try {
    await pc.setRemoteDescription(offerDesc);
    console.log(`✅ Remote offer set from ${sender}`);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendMessage({
      type: "answer",
      answer: answer,
      target: sender,
      sender: wsRef.current.id,
    });

    console.log(`✅ Answer sent to ${sender}`);

    // 🔥 Drain buffered ICE candidates
    const pending = pendingCandidatesRef.current[sender];
    if (pending && pending.length > 0) {
      console.log(`🧊 Adding ${pending.length} buffered ICE candidates for ${sender}`);
      for (const cand of pending) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.error("❌ Failed to add buffered ICE candidate:", e);
        }
      }
      pendingCandidatesRef.current[sender] = [];
    }

  } catch (error) {
    console.error("❌ Error handling offer:", error);
  }
};
  
const handleAnswer = async ({ answer, sender }) => {
  const pc = pcs[sender];

  if (!pc) {
    console.log(`No peer connection found for sender: ${sender}`);
    return;
  }

  try {
    if (pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`✅ Set remote description for ${sender}`);

      // 🔥 Drain buffered ICE candidates
      const pending = pendingCandidatesRef.current[sender];
      if (pending && pending.length > 0) {
        console.log(`🧊 Adding ${pending.length} buffered ICE candidates for ${sender}`);
        for (const cand of pending) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (e) {
            console.error("❌ Failed to add buffered ICE candidate:", e);
          }
        }
        pendingCandidatesRef.current[sender] = [];
      }

    } else {
      console.warn(`⚠️ Unexpected signaling state '${pc.signalingState}' when handling answer from ${sender}`);
    }
  } catch (error) {
    console.error("❌ Error setting remote description:", error);
  }
};
  
  const handleCandidate = async ({ candidate, sender }) => {
    const pc = pcs[sender];
  
    if (!pc) {
      console.log(`No peer connection found for sender: ${sender}`);
      return;
    }
  
    if (!pc.remoteDescription || pc.remoteDescription.type === "") {
      console.log(`🔁 Buffering ICE candidate from ${sender}`);
      if (!pendingCandidatesRef.current[sender]) {
        pendingCandidatesRef.current[sender] = [];
      }
      pendingCandidatesRef.current[sender].push(candidate);
      return;
    }
  
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log(`✅ ICE candidate added from ${sender}`);
    } catch (error) {
      console.error("❌ Error adding ICE candidate:", error);
    }
  };
  
  const createRoom = async () => {
    const id = Math.random().toString(36).substring(2, 8);
    setRoomId(id);
    await joinRoom(id);
  };

  const joinRoom = async (id) => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    setLocalStream(stream);
    localStreamRef.current = stream;
    createWebSocket(id);
    setRoomId(id);
    setInRoom(true);
  };

  const leaveRoom = () => {
    sendMessage({ type: "bye", sender: wsRef.current.id });

    Object.values(pcs).forEach((pc) => pc.close());
    setPcs({});
    setRemoteStreams({});
    setInRoom(false);
    wsRef.current?.close();
    setRoomId("");
  };

  const toggleAudio = () => {
    const newState = !audioEnabled;
    localStream?.getAudioTracks().forEach(track => (track.enabled = newState));
    setAudioEnabled(newState);
  };

  const toggleVideo = () => {
    const newState = !videoEnabled;
    localStream?.getVideoTracks().forEach(track => (track.enabled = newState));
    setVideoEnabled(newState);
  };


  return (
    <div>
      <h2>WebRTC Room</h2>
      {!inRoom && (
        <>
          <button onClick={createRoom}>Create Room</button>
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Room ID"
          />
          <button onClick={() => joinRoom(roomId)}>Join Room</button>
        </>
      )}
      {inRoom && (
        <>
          <p>🆔 Room: {roomId}</p>
          <button onClick={leaveRoom}>Leave</button>
          <button onClick={toggleAudio}>
            {audioEnabled ? "Mute" : "Unmute"}
          </button>
          <button onClick={toggleVideo}>
            {videoEnabled ? "Stop Video" : "Start Video"}
          </button>
        </>
      )}

      <div>
        <h3>Local Stream</h3>
        <video ref={localVideoRef} autoPlay muted playsInline width="200" />
      </div>

      <div>
      <h3>Remote Streams</h3>
      {Object.entries(remoteStreams).map(([id, stream]) => (
  <video
    key={id}
    ref={(el) => {
      if (el && stream) {
        el.srcObject = stream;
        el.onloadedmetadata = () => el.play();
      }
    }}
    autoPlay
    playsInline
    width="200"
    muted={false}
  />
))}
    </div>
    </div>
  );
};

export default WebRTCRoom;