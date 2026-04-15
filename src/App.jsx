import { useState, useRef, useEffect, useCallback } from "react";

// ============================================================
// CONFIG
// ============================================================
const CLIENT_ID = "320449047529-doh59lh7q8jo393scvlhv7baf9jp6p2g.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.file";

// IDs directos de las carpetas en Google Drive (no se crean carpetas nuevas)
const DESTINATARIOS = {
  MSA: { label: "MSA", color: "#f59e0b", folderId: "1ktJIwI6TRU521f9Uktf04rC0F89FBsOv" },
  PAM: { label: "PAM", color: "#3b82f6", folderId: "19pugZcibLjDqbSZG-vmgecx4aN3t6i4_" },
  MA:  { label: "MA",  color: "#10b981", folderId: "18IrmWvQbRkpiHyCPFDngLcud_xpBFMax" },
};

// ============================================================
// HELPERS
// ============================================================
function fmtShort(d) {
  const y = d.getFullYear().toString().slice(-2);
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fmtInput(d) { return d.toISOString().split("T")[0]; }
function fmtHuman(d) { return d.toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" }); }

// LocalStorage helpers
function lsGet(k, def) { try { return JSON.parse(localStorage.getItem(k)) || def; } catch { return def; } }
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

function getQueue() { return lsGet("af_queue", []); }
function saveQueue(q) { lsSet("af_queue", q); }
function getProviders() { return lsGet("af_providers", []); }
function saveProviders(l) { lsSet("af_providers", l); }
function addProvider(name) {
  const l = getProviders();
  if (!l.find(p => p.toLowerCase() === name.toLowerCase())) {
    l.unshift(name);
    saveProviders(l.slice(0, 50));
  }
}
function getHistory() { return lsGet("af_history", []); }
function saveHistory(h) { lsSet("af_history", h.slice(0, 30)); }

// ============================================================
// GOOGLE DRIVE API
// ============================================================
async function ensureFolderPath(token, path) {
  const parts = path.split("/");
  let parentId = "root";
  for (const name of parts) {
    const q = encodeURIComponent(
      `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    if (data.files?.length > 0) {
      parentId = data.files[0].id;
    } else {
      const cr = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
      });
      const res = await cr.json();
      if (!res.id) throw new Error(`No se pudo crear la carpeta "${name}"`);
      parentId = res.id;
    }
  }
  return parentId;
}

async function uploadFile(token, folderId, fileName, base64, mimeType) {
  const bin = atob(base64.split(",")[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: mimeType });
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify({ name: fileName, parents: [folderId] })], { type: "application/json" })
  );
  form.append("file", blob);
  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }
  );
  return r.json();
}

// ============================================================
// GOOGLE AUTH HOOK
// ============================================================
function useAuth() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const tcRef = useRef(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("af_tok");
    if (stored) {
      setToken(stored);
      setUser({ email: sessionStorage.getItem("af_email") || "" });
    }
    if (document.querySelector('script[src*="accounts.google.com/gsi/client"]')) {
      setReady(true);
      return;
    }
    const sc = document.createElement("script");
    sc.src = "https://accounts.google.com/gsi/client";
    sc.async = true;
    sc.onload = () => setReady(true);
    document.body.appendChild(sc);
  }, []);

  useEffect(() => {
    if (!ready || !window.google) return;
    tcRef.current = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.access_token) {
          setToken(resp.access_token);
          sessionStorage.setItem("af_tok", resp.access_token);
          fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${resp.access_token}` },
          })
            .then((r) => r.json())
            .then((d) => {
              setUser({ email: d.email, name: d.name });
              sessionStorage.setItem("af_email", d.email || "");
            })
            .catch(() => setUser({ email: "Usuario" }));
        }
      },
    });
  }, [ready]);

  const login = useCallback(() => tcRef.current?.requestAccessToken(), []);
  const logout = useCallback(() => {
    if (token) window.google?.accounts.oauth2.revoke(token);
    setToken(null);
    setUser(null);
    sessionStorage.removeItem("af_tok");
    sessionStorage.removeItem("af_email");
  }, [token]);

  return { token, user, login, logout, ready };
}

// ============================================================
// MAIN APP COMPONENT
// ============================================================
export default function App() {
  const { token, user, login, logout, ready } = useAuth();

  // Steps: foto → datos → confirmar → subiendo → listo
  const [step, setStep] = useState("foto");
  const [photo, setPhoto] = useState(null);
  const [mime, setMime] = useState("image/jpeg");
  const [dest, setDest] = useState(null);
  const [isToday, setIsToday] = useState(false);
  const [dateChosen, setDateChosen] = useState(false);
  const [customDate, setCustomDate] = useState(fmtInput(new Date()));
  const [prov, setProv] = useState("");
  const [showSug, setShowSug] = useState(false);
  const [status, setStatus] = useState(null); // null | uploading | success | error | queued
  const [errMsg, setErrMsg] = useState("");
  const [driveLink, setDriveLink] = useState("");
  const [history, setHistory] = useState(getHistory());
  const [queue, setQueue] = useState(getQueue());
  const [online, setOnline] = useState(navigator.onLine);
  const fileRef = useRef(null);

  const now = new Date();
  const effDate = isToday ? now : new Date(customDate + "T12:00:00");
  const ext = mime === "application/pdf" ? "pdf" : "jpg";
  const fileName = `${fmtShort(effDate)} - ${prov || "proveedor"}.${ext}`;
  const canGo = photo && prov.trim() && dest && dateChosen;

  const provList = getProviders().filter(
    (p) => p.toLowerCase().includes(prov.toLowerCase()) && prov.length > 0
  );

  // Online/offline
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Auto-sync queue when back online
  useEffect(() => {
    if (online && token && queue.length > 0) syncQueue();
  }, [online, token]);

  async function syncQueue() {
    const q = [...queue];
    const remain = [];
    for (const it of q) {
      try {
        await uploadFile(token, it.folderId, it.fileName, it.photo, it.mime);
        const nh = [
          { name: it.fileName, dest: it.dest, date: new Date().toISOString(), ok: true },
          ...history,
        ];
        setHistory(nh);
        saveHistory(nh);
      } catch {
        remain.push(it);
      }
    }
    setQueue(remain);
    saveQueue(remain);
  }

  function handlePhoto(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setMime(f.type || "image/jpeg");
    const r = new FileReader();
    r.onload = (ev) => {
      setPhoto(ev.target.result);
      setStep("datos");
    };
    r.readAsDataURL(f);
  }

  function retake() {
    setPhoto(null);
    setStep("foto");
    setTimeout(() => fileRef.current?.click(), 150);
  }

  async function doUpload() {
    if (!canGo) return;
    setStep("subiendo");
    setStatus("uploading");
    addProvider(prov);
    const folderId = DESTINATARIOS[dest].folderId;

    if (!online || !token) {
      const it = { fileName, photo, mime, folderId, dest, date: new Date().toISOString() };
      const nq = [...queue, it];
      setQueue(nq);
      saveQueue(nq);
      setStatus("queued");
      setStep("listo");
      return;
    }

    try {
      const res = await uploadFile(token, folderId, fileName, photo, mime);
      if (res.id) {
        setDriveLink(res.webViewLink || "");
        setStatus("success");
        const nh = [
          { name: fileName, dest, date: new Date().toISOString(), ok: true, link: res.webViewLink },
          ...history,
        ];
        setHistory(nh);
        saveHistory(nh);
        setStep("listo");
      } else {
        throw new Error(res.error?.message || "Error desconocido al subir");
      }
    } catch (err) {
      setErrMsg(err.message);
      setStatus("error");
      // Save to offline queue as fallback
      const it = { fileName, photo, mime, folderId, dest, date: new Date().toISOString() };
      const nq = [...queue, it];
      setQueue(nq);
      saveQueue(nq);
      setStep("listo");
    }
  }

  function reset() {
    setStep("foto");
    setPhoto(null);
    setDest(null);
    setIsToday(false);
    setDateChosen(false);
    setCustomDate(fmtInput(new Date()));
    setProv("");
    setStatus(null);
    setErrMsg("");
    setDriveLink("");
  }

  // ============================================================
  // COLORS
  // ============================================================
  const C = {
    bg: "#0b1121",
    card: "rgba(255,255,255,0.025)",
    bdr: "rgba(255,255,255,0.07)",
    txt: "#e2e8f0",
    mut: "#64748b",
    acc: "#38bdf8",
    ok: "#34d399",
    warn: "#fbbf24",
    err: "#f87171",
  };

  const wrap = {
    fontFamily: "'DM Sans', sans-serif",
    minHeight: "100vh",
    background: `linear-gradient(170deg, ${C.bg}, #111b2e, #0f1d30)`,
    color: C.txt,
    maxWidth: 480,
    margin: "0 auto",
  };

  const inputStyle = {
    width: "100%",
    padding: "11px 14px",
    background: "rgba(255,255,255,0.035)",
    border: `1px solid ${C.bdr}`,
    borderRadius: 10,
    color: C.txt,
    fontSize: 15,
    outline: "none",
    boxSizing: "border-box",
  };

  const labelStyle = {
    fontSize: 11,
    color: C.mut,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
    display: "block",
    marginBottom: 8,
  };

  // ============================================================
  // LOGIN SCREEN
  // ============================================================
  if (!token) {
    return (
      <div
        style={{
          ...wrap,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          textAlign: "center",
        }}
      >
        <h1
          style={{
            fontSize: 30,
            fontWeight: 800,
            margin: "0 0 6px",
            background: "linear-gradient(135deg, #38bdf8, #34d399)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          ArchiFactura
        </h1>
        <p style={{ color: C.mut, fontSize: 13, margin: "0 0 40px" }}>
          Archivo de comprobantes en Google Drive
        </p>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            background: "linear-gradient(135deg, rgba(56,189,248,0.12), rgba(52,211,153,0.08))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 36,
          }}
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <path d="M8.5 2L15.5 2L23 15H16L8.5 2Z" fill="#34a853" opacity=".8" />
            <path d="M1 15L8.5 2L12.25 8.5L4.75 21.5L1 15Z" fill="#4285f4" opacity=".8" />
            <path d="M4.75 21.5L12.25 8.5L16 15H23L19.25 21.5H4.75Z" fill="#fbbc04" opacity=".8" />
          </svg>
        </div>
        <button
          onClick={login}
          disabled={!ready}
          style={{
            padding: "15px 32px",
            background: "linear-gradient(135deg, #38bdf8, #34d399)",
            border: "none",
            borderRadius: 12,
            color: C.bg,
            fontSize: 15,
            fontWeight: 700,
            cursor: ready ? "pointer" : "default",
            opacity: ready ? 1 : 0.5,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          Iniciar sesión con Google
        </button>
        <p style={{ color: C.mut, fontSize: 11, marginTop: 20, maxWidth: 260 }}>
          Usá la cuenta de Google que tiene el Drive de San Manuel
        </p>
        <style>{globalCSS}</style>
      </div>
    );
  }

  // ============================================================
  // MAIN UI
  // ============================================================
  const allSteps = ["foto", "datos", "confirmar", "listo"];
  const si = Math.min(allSteps.indexOf(step === "subiendo" ? "confirmar" : step), 3);

  return (
    <div style={wrap}>
      {/* HEADER */}
      <div
        style={{
          padding: "14px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${C.bdr}`,
        }}
      >
        <h1
          style={{
            fontSize: 19,
            fontWeight: 800,
            margin: 0,
            background: "linear-gradient(135deg, #38bdf8, #34d399)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          ArchiFactura
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {queue.length > 0 && (
            <span
              style={{
                background: `${C.warn}18`,
                border: `1px solid ${C.warn}35`,
                borderRadius: 7,
                padding: "3px 9px",
                fontSize: 11,
                color: C.warn,
              }}
            >
              ⏳ {queue.length}
            </span>
          )}
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: online ? C.ok : C.err,
              display: "inline-block",
            }}
          />
          <span
            onClick={logout}
            style={{
              fontSize: 11,
              color: C.mut,
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            Salir
          </span>
        </div>
      </div>

      {/* PROGRESS BAR */}
      <div style={{ padding: "12px 20px 8px", display: "flex", gap: 4 }}>
        {allSteps.map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: i <= si ? "linear-gradient(90deg, #38bdf8, #34d399)" : C.bdr,
              transition: "all 0.3s",
            }}
          />
        ))}
      </div>

      <div style={{ padding: "16px 20px 100px" }}>
        {/* ========================================= */}
        {/* STEP: FOTO                                */}
        {/* ========================================= */}
        {step === "foto" && (
          <div style={{ animation: "fu .3s ease" }}>
            <p style={{ fontSize: 14, color: C.mut, margin: "0 0 18px" }}>
              Sacale una foto a la factura o elegí un archivo
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              onChange={handlePhoto}
              style={{ display: "none" }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              style={{
                width: "100%",
                padding: "48px 20px",
                background: "rgba(56,189,248,0.03)",
                border: "2px dashed rgba(56,189,248,0.18)",
                borderRadius: 16,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 12,
                color: C.acc,
              }}
            >
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Tomar foto / Elegir archivo</span>
              <span style={{ fontSize: 12, color: C.mut }}>JPG, PNG o PDF</span>
            </button>

            {/* HISTORIAL */}
            {history.length > 0 && (
              <div style={{ marginTop: 28 }}>
                <span style={labelStyle}>Últimas subidas</span>
                {history.slice(0, 5).map((it, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "10px 12px",
                      marginTop: 6,
                      background: C.card,
                      border: `1px solid ${C.bdr}`,
                      borderRadius: 10,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{it.name}</p>
                      <p style={{ fontSize: 11, color: C.mut, margin: "2px 0 0" }}>
                        {it.ok ? "✓ Subido" : "⏳ Pendiente"}
                      </p>
                    </div>
                    <span
                      style={{
                        background: (DESTINATARIOS[it.dest]?.color || C.acc) + "20",
                        color: DESTINATARIOS[it.dest]?.color || C.acc,
                        padding: "3px 8px",
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      {it.dest}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ========================================= */}
        {/* STEP: DATOS                               */}
        {/* ========================================= */}
        {step === "datos" && (
          <div style={{ animation: "fu .3s ease" }}>
            {/* Photo preview - FULL SIZE */}
            {photo && mime !== "application/pdf" && (
              <div style={{ marginBottom: 18 }}>
                <div
                  style={{
                    width: "100%",
                    borderRadius: 12,
                    overflow: "hidden",
                    border: `1px solid ${C.bdr}`,
                    background: "#000",
                  }}
                >
                  <img
                    src={photo}
                    alt="factura"
                    style={{
                      width: "100%",
                      display: "block",
                      maxHeight: 400,
                      objectFit: "contain",
                    }}
                  />
                </div>
                <button
                  onClick={retake}
                  style={{
                    marginTop: 8,
                    padding: "8px 14px",
                    background: "rgba(248,113,113,0.08)",
                    border: "1px solid rgba(248,113,113,0.2)",
                    borderRadius: 8,
                    color: C.err,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 4v6h6" />
                    <path d="M23 20v-6h-6" />
                    <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
                  </svg>
                  Sacar de nuevo
                </button>
              </div>
            )}

            {/* PDF preview */}
            {photo && mime === "application/pdf" && (
              <div
                style={{
                  padding: 14,
                  marginBottom: 18,
                  background: C.card,
                  border: `1px solid ${C.bdr}`,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 26 }}>📄</span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>PDF cargado</span>
                </div>
                <button
                  onClick={retake}
                  style={{
                    padding: "6px 12px",
                    background: "rgba(248,113,113,0.08)",
                    border: "1px solid rgba(248,113,113,0.2)",
                    borderRadius: 8,
                    color: C.err,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Cambiar
                </button>
              </div>
            )}

            {/* DESTINATARIO */}
            <div style={{ marginBottom: 18 }}>
              <span style={labelStyle}>Destinatario</span>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.entries(DESTINATARIOS).map(([k, v]) => (
                  <button
                    key={k}
                    onClick={() => setDest(k)}
                    style={{
                      flex: 1,
                      padding: "12px 8px",
                      textAlign: "center",
                      background: dest === k ? v.color + "18" : "rgba(255,255,255,0.025)",
                      border: `2px solid ${dest === k ? v.color : "rgba(255,255,255,0.07)"}`,
                      borderRadius: 12,
                      color: dest === k ? v.color : C.mut,
                      fontSize: 16,
                      fontWeight: 700,
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            {/* FECHA */}
            <div style={{ marginBottom: 18 }}>
              <span style={labelStyle}>Fecha de factura</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  onClick={() => { setIsToday(!isToday); setDateChosen(true); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: isToday ? `${C.ok}12` : "rgba(255,255,255,0.025)",
                    border: `1px solid ${isToday ? C.ok + "40" : C.bdr}`,
                    borderRadius: 10,
                    padding: "10px 16px",
                    color: isToday ? C.ok : C.mut,
                    cursor: "pointer",
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      border: `2px solid ${isToday ? C.ok : "#475569"}`,
                      background: isToday ? C.ok : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {isToday && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={C.bg} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  Hoy
                </button>
                {dateChosen && (
                  <span
                    style={{
                      fontSize: 15,
                      color: C.mut,
                      fontWeight: 600,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {fmtShort(effDate)}
                  </span>
                )}
                {!dateChosen && (
                  <span style={{ fontSize: 13, color: C.err, fontWeight: 500 }}>
                    ← Elegí una fecha
                  </span>
                )}
              </div>
              {!isToday && (
                <input
                  type="date"
                  value={customDate}
                  onChange={(e) => { setCustomDate(e.target.value); setDateChosen(true); }}
                  style={{ ...inputStyle, marginTop: 10 }}
                />
              )}
            </div>

            {/* PROVEEDOR */}
            <div style={{ marginBottom: 18, position: "relative" }}>
              <span style={labelStyle}>Proveedor</span>
              <input
                type="text"
                value={prov}
                onChange={(e) => {
                  setProv(e.target.value);
                  setShowSug(true);
                }}
                onFocus={() => setShowSug(true)}
                onBlur={() => setTimeout(() => setShowSug(false), 200)}
                placeholder="Escribí el nombre del proveedor..."
                style={inputStyle}
              />
              {showSug && provList.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    background: "#1a2d45",
                    border: `1px solid ${C.bdr}`,
                    borderRadius: 10,
                    marginTop: 4,
                    overflow: "hidden",
                    zIndex: 20,
                    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                  }}
                >
                  {provList.slice(0, 6).map((p) => (
                    <div
                      key={p}
                      onClick={() => {
                        setProv(p);
                        setShowSug(false);
                      }}
                      style={{
                        padding: "10px 14px",
                        cursor: "pointer",
                        fontSize: 14,
                        color: "#cbd5e1",
                        borderBottom: `1px solid ${C.bdr}`,
                      }}
                    >
                      {p}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* FILE NAME PREVIEW */}
            <div
              style={{
                padding: "12px 14px",
                background: `${C.acc}08`,
                border: `1px solid ${C.acc}15`,
                borderRadius: 10,
                marginBottom: 20,
              }}
            >
              <span style={{ fontSize: 10, color: C.mut, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
                Se guardará como
              </span>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.acc,
                  fontFamily: "'JetBrains Mono', monospace",
                  margin: "4px 0 0",
                }}
              >
                {fileName}
              </p>
              {dest && (
                <p style={{ fontSize: 12, color: C.mut, margin: "4px 0 0" }}>
                  📁 .../{DESTINATARIOS[dest].label}/
                </p>
              )}
            </div>

            {/* BUTTONS */}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => {
                  setStep("foto");
                  setPhoto(null);
                }}
                style={{
                  flex: 1,
                  padding: 14,
                  background: "rgba(255,255,255,0.03)",
                  border: `1px solid ${C.bdr}`,
                  borderRadius: 12,
                  color: C.mut,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                ← Volver
              </button>
              <button
                onClick={() => canGo && setStep("confirmar")}
                disabled={!canGo}
                style={{
                  flex: 2,
                  padding: 14,
                  background: canGo ? "linear-gradient(135deg, #38bdf8, #34d399)" : "rgba(255,255,255,0.03)",
                  border: "none",
                  borderRadius: 12,
                  color: canGo ? C.bg : "#475569",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: canGo ? "pointer" : "default",
                  opacity: canGo ? 1 : 0.4,
                }}
              >
                Continuar →
              </button>
            </div>
          </div>
        )}

        {/* ========================================= */}
        {/* STEP: CONFIRMAR                           */}
        {/* ========================================= */}
        {step === "confirmar" && (
          <div style={{ animation: "fu .3s ease" }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 16px" }}>Confirmá los datos</h2>
            <div
              style={{
                background: C.card,
                border: `1px solid ${C.bdr}`,
                borderRadius: 14,
                overflow: "hidden",
              }}
            >
              {photo && mime !== "application/pdf" && (
                <img
                  src={photo}
                  alt=""
                  style={{
                    width: "100%",
                    maxHeight: 180,
                    objectFit: "cover",
                    borderBottom: `1px solid ${C.bdr}`,
                  }}
                />
              )}
              <div style={{ padding: 16 }}>
                {[
                  [
                    "Destinatario",
                    <span key="d" style={{ color: DESTINATARIOS[dest]?.color, fontWeight: 700 }}>
                      {DESTINATARIOS[dest]?.label}
                    </span>,
                  ],
                  [
                    "Fecha",
                    <>
                      {fmtHuman(effDate)}
                      {isToday && (
                        <span style={{ color: C.ok, fontSize: 12, marginLeft: 8 }}>hoy</span>
                      )}
                    </>,
                  ],
                  ["Proveedor", prov],
                  [
                    "Archivo",
                    <span
                      key="f"
                      style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: C.acc }}
                    >
                      {fileName}
                    </span>,
                  ],
                  [
                    "Destino",
                    <span key="dest" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      📁 .../{DESTINATARIOS[dest]?.label}/
                    </span>,
                  ],
                ].map(([label, val], i) => (
                  <div key={i} style={{ marginBottom: i < 4 ? 12 : 0 }}>
                    <p
                      style={{
                        fontSize: 10,
                        color: C.mut,
                        margin: 0,
                        textTransform: "uppercase",
                        fontWeight: 700,
                        letterSpacing: 1,
                      }}
                    >
                      {label}
                    </p>
                    <p style={{ fontSize: 15, fontWeight: 600, margin: "3px 0 0" }}>{val}</p>
                  </div>
                ))}
              </div>
            </div>

            {!online && (
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 14px",
                  background: `${C.warn}0a`,
                  border: `1px solid ${C.warn}25`,
                  borderRadius: 10,
                  fontSize: 13,
                  color: C.warn,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                ⚠️ Sin conexión — se guardará en cola local
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button
                onClick={() => setStep("datos")}
                style={{
                  flex: 1,
                  padding: 14,
                  background: "rgba(255,255,255,0.03)",
                  border: `1px solid ${C.bdr}`,
                  borderRadius: 12,
                  color: C.mut,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                ← Editar
              </button>
              <button
                onClick={doUpload}
                style={{
                  flex: 2,
                  padding: 14,
                  background: "linear-gradient(135deg, #38bdf8, #34d399)",
                  border: "none",
                  borderRadius: 12,
                  color: C.bg,
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M8.5 2L15.5 2L23 15H16L8.5 2Z" fill="#0b1121" opacity=".6" />
                  <path d="M1 15L8.5 2L12.25 8.5L4.75 21.5L1 15Z" fill="#0b1121" opacity=".6" />
                  <path d="M4.75 21.5L12.25 8.5L16 15H23L19.25 21.5H4.75Z" fill="#0b1121" opacity=".6" />
                </svg>
                Guardar factura
              </button>
            </div>
          </div>
        )}

        {/* ========================================= */}
        {/* STEP: SUBIENDO                            */}
        {/* ========================================= */}
        {step === "subiendo" && (
          <div style={{ animation: "fu .3s ease", textAlign: "center", paddingTop: 60 }}>
            <div
              style={{
                width: 56,
                height: 56,
                border: "3px solid rgba(56,189,248,0.2)",
                borderTopColor: C.acc,
                borderRadius: "50%",
                margin: "0 auto 20px",
                animation: "spin .8s linear infinite",
              }}
            />
            <p style={{ fontSize: 16, fontWeight: 600 }}>Subiendo a Google Drive...</p>
            <p style={{ fontSize: 13, color: C.mut }}>{fileName}</p>
          </div>
        )}

        {/* ========================================= */}
        {/* STEP: LISTO                               */}
        {/* ========================================= */}
        {step === "listo" && (
          <div style={{ animation: "fu .3s ease", textAlign: "center", paddingTop: 40 }}>
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: "50%",
                margin: "0 auto 18px",
                background:
                  status === "success"
                    ? `linear-gradient(135deg, ${C.ok}25, ${C.acc}15)`
                    : status === "queued"
                    ? `${C.warn}18`
                    : `${C.err}15`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {status === "success" && (
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke={C.ok} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
              {status === "queued" && <span style={{ fontSize: 28 }}>⏳</span>}
              {status === "error" && <span style={{ fontSize: 28 }}>⚠️</span>}
            </div>

            <h2
              style={{
                fontSize: 20,
                fontWeight: 700,
                margin: "0 0 6px",
                color: status === "success" ? C.ok : status === "queued" ? C.warn : C.err,
              }}
            >
              {status === "success"
                ? "¡Factura archivada!"
                : status === "queued"
                ? "Guardada en cola"
                : "Error al subir"}
            </h2>
            <p style={{ fontSize: 13, color: C.mut, margin: "0 0 4px" }}>
              {status === "success"
                ? "El archivo ya está en Google Drive"
                : status === "queued"
                ? "Se subirá automáticamente con conexión"
                : "Se guardó en cola local para reintentar"}
            </p>
            {errMsg && <p style={{ fontSize: 12, color: C.err, margin: "4px 0" }}>{errMsg}</p>}
            <p
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: C.acc,
                fontFamily: "'JetBrains Mono', monospace",
                margin: "14px 0 0",
              }}
            >
              {fileName}
            </p>
            <p style={{ fontSize: 12, color: C.mut }}>📁 .../{DESTINATARIOS[dest]?.label}/</p>

            {driveLink && (
              <a
                href={driveLink}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-block",
                  marginTop: 8,
                  fontSize: 13,
                  color: C.acc,
                  textDecoration: "underline",
                }}
              >
                Ver en Google Drive ↗
              </a>
            )}

            <div>
              <button
                onClick={reset}
                style={{
                  marginTop: 28,
                  padding: "14px 32px",
                  background: "linear-gradient(135deg, #38bdf8, #34d399)",
                  border: "none",
                  borderRadius: 12,
                  color: C.bg,
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Archivar otra factura
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{globalCSS}</style>
    </div>
  );
}

const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap');
  @keyframes fu { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.7); }
  * { box-sizing: border-box; }
  body { margin: 0; }
`;
