'use client'

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from './upload-limit'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, ArrowDownToLine, Check, Copy, Eye, EyeOff, File, Inbox, LockKeyhole, Moon, PackageOpen, Plus, Sun, Upload, Wifi, X } from 'lucide-react'
import QRCode from 'qrcode'
import ExpiryPicker from './expiry-picker'
import { Activity, FileRequests, auth, label, downloadUrl } from './requests'

const api = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '') + '/api'
const shelfKey = 'dropshelf.drops'
const hosted = Boolean(process.env.NEXT_PUBLIC_API_URL)
type Drop = { id: string; name: string; size: number; expires: number; owner: string }
type Unlocked = { name: string; size: number; ticket: string; files: { name: string; size: number }[] }

function fileSize(bytes: number) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

function expiry(seconds: number) { return new Date(seconds * 1000).toLocaleString() }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(api + path, options)
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Something went wrong. Try again.')
  return body
}

export default function Shelf({ receive = false, collect = false }: { receive?: boolean; collect?: boolean }) {
  const [theme, setTheme] = useState('')
  const [tab, setTab] = useState<'create' | 'shelf' | 'requests'>('create')
  const [drops, setDrops] = useState<Drop[]>([])
  const [selected, setSelected] = useState<Drop | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [showActivity, setShowActivity] = useState(false)
  const [asking, setAsking] = useState(false)
  const [guest, setGuest] = useState('')
  const [access, setAccess] = useState<{ key: string; proof: string }>()
  const [accessState, setAccessState] = useState('pending')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [hours, setHours] = useState('24')
  const [progress, setProgress] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [origin, setOrigin] = useState('')
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)
  const [id, setId] = useState('')
  const [expires, setExpires] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const [checking, setChecking] = useState(receive)
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null)
  const [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const upload = useRef<XMLHttpRequest | null>(null)
  const linkField = useRef<HTMLInputElement>(null)
  const link = selected && origin ? origin + '/drop/?id=' + selected.id : ''

  useEffect(() => {
    const preference = localStorage.getItem('dropshelf.theme')
    if (preference) document.documentElement.dataset.theme = preference
    setTheme(preference || '')
    setOrigin(window.location.origin)
    if (!receive) {
      try { setDrops(JSON.parse(localStorage.getItem(shelfKey) || '[]')) } catch { setDrops([]) }
      if (!hosted && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        request<{host: string}>('/network').then(({ host }) => {
          if (!host) return
          const url = new URL(window.location.origin)
          url.hostname = host
          setOrigin(url.origin)
        }).catch(() => {})
      }
      return
    }
    const dropId = new URLSearchParams(window.location.search).get('id') || ''
    setId(dropId)
    try { setAccess(JSON.parse(localStorage.getItem('dropshelf.access.' + dropId) || 'null') || undefined) } catch { setAccess(undefined) }
    if (!/^drop_[a-zA-Z0-9_-]{24}$/.test(dropId)) {
      setUnavailable(true)
      setChecking(false)
      return
    }
    request<{expires: number}>('/drops/' + dropId).then(result => setExpires(result.expires))
      .catch(() => setUnavailable(true)).finally(() => setChecking(false))
  }, [receive])

  useEffect(() => {
    setQr('')
    if (!link) return
    let active = true
    QRCode.toDataURL(link, { width: 288, margin: 2, errorCorrectionLevel: 'M' })
      .then(value => { if (active) setQr(value) }).catch(() => {})
    return () => { active = false }
  }, [link])

  useEffect(() => {
    if (!expires) return
    const timer = setTimeout(() => setUnavailable(true), Math.max(0, expires * 1000 - Date.now()))
    return () => clearTimeout(timer)
  }, [expires])

  function toggleTheme() {
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    const next = dark ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('dropshelf.theme', next)
    setTheme(next)
  }

  function saveDrops(items: Drop[]) {
    setDrops(items)
    localStorage.setItem(shelfKey, JSON.stringify(items))
  }

  function choose(next: FileList | null) {
    const items = Array.from(next || [])
    if (!items.length) return
    if (items.length > 10 || items.reduce((total, item) => total + item.size, 0) > MAX_UPLOAD_BYTES) {
      setError('Choose up to 10 files totaling ' + MAX_UPLOAD_LABEL + '.'); return
    }
    setFiles(items)
    setError('')
  }

  function create(event: FormEvent) {
    event.preventDefault()
    if (!files.length) { setError('Choose a file first.'); return }
    setError('')
    setProgress(0)
    const xhr = new XMLHttpRequest()
    upload.current = xhr
    xhr.open('POST', api + '/drops')
    xhr.responseType = 'json'
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(files[0].name))
    if (files.length > 1) {
      xhr.setRequestHeader('X-File-Manifest', encodeURIComponent(JSON.stringify(files.map(({ name, size }) => ({ name, size })))))
    }
    xhr.setRequestHeader('X-Drop-Password', encodeURIComponent(password))
    xhr.setRequestHeader('X-Expires-Hours', hours)
    xhr.upload.onprogress = event => { if (event.lengthComputable && event.total) setProgress(Math.round(event.loaded / event.total * 100)) }
    xhr.onload = () => {
      setProgress(null)
      upload.current = null
      if (xhr.status !== 201) { setError(xhr.response?.detail || 'Upload failed. Try again.'); return }
      const drop = xhr.response as Drop
      saveDrops([drop, ...drops])
      setSelected(drop)
      setFiles([])
      setPassword('')
    }
    xhr.onerror = () => { setProgress(null); upload.current = null; setError('Could not reach the file server.') }
    xhr.onabort = () => { setProgress(null); upload.current = null }
    xhr.send(files.length === 1 ? files[0] : new Blob(files))
  }

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error()
      await navigator.clipboard.writeText(link)
    } catch {
      linkField.current?.select()
      if (!document.execCommand('copy')) { setError('Link selected. Copy it using your device’s Copy command.'); return }
    }
    setError('')
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  async function revoke(drop: Drop) {
    if (!window.confirm('Revoke this link and delete the shared copy?')) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(api + '/drops/' + drop.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + drop.owner } })
      if (!response.ok && response.status !== 410) throw new Error()
      saveDrops(drops.filter(item => item.id !== drop.id))
      setSelected(null)
      setTab('shelf')
    } catch { setError('Could not revoke this drop. Try again.') }
    finally { setBusy(false) }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      setUnlocked(await request<Unlocked>('/drops/' + id + '/unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
      }))
      setPassword('')
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }

  function navigate(next: 'create' | 'shelf' | 'requests') { setTab(next); setSelected(null); setShowActivity(false); setError('') }

  async function ask(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const entry = await request<{ key: string; proof: string }>('/drops/' + id + '/access', label(guest))
      localStorage.setItem('dropshelf.access.' + id, JSON.stringify(entry))
      setAccess(entry)
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }

  async function checkAccess() {
    if (!access) return
    setBusy(true)
    setError('')
    try {
      const result = await request<{state: string; file?: Unlocked}>('/drops/' + id + '/access/' + access.key + '/check', { method: 'POST', headers: auth(access.proof) })
      setAccessState(result.state)
      if (result.file) setUnlocked(result.file)
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }

  const passwordControl = <div className="input password-input">
    <LockKeyhole size={17} /><input id="password" type={visible ? 'text' : 'password'} value={password}
      onChange={event => setPassword(event.target.value)} placeholder="Enter password"
      required disabled={busy || progress !== null}
      autoComplete={receive ? 'current-password' : 'new-password'} />
    <button type="button" className="bare" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>
      {visible ? <EyeOff size={17} /> : <Eye size={17} />}
    </button>
  </div>

  return <div className="shell">
    <header><a className="brand" href="/"><span className="brand-icon"><Archive size={21} /></span>DropShelf</a>
      <nav aria-label="App navigation">
        <button className="theme" aria-label="Toggle light and dark mode" onClick={toggleTheme}><Sun className="sun" size={18} /><Moon className="moon" size={18} /></button>
      </nav>
    </header>
    {!receive && !collect && <div className="nav-strip"><nav className="segments" data-section={tab} aria-label="DropShelf sections">
      <button aria-current={tab === 'create' ? 'page' : undefined} disabled={progress !== null} onClick={() => navigate('create')}><Plus size={17} />New drop</button>
      <button aria-current={tab === 'shelf' ? 'page' : undefined} disabled={progress !== null} onClick={() => navigate('shelf')}><Archive size={17} />My shelf</button>
      <button aria-current={tab === 'requests' ? 'page' : undefined} disabled={progress !== null} onClick={() => navigate('requests')}><Inbox size={17} />File requests</button>
    </nav></div>}
    <main>
      {collect || tab === 'requests' ? <FileRequests origin={origin} receive={collect} /> : receive ? <section className="card receive" key={unlocked ? 'ready' : 'receive'}>
        <span className="hero-icon">{unlocked && !unavailable ? <Check /> : <LockKeyhole />}</span>
        <h1>{checking ? 'Opening drop…' : unavailable ? 'Drop unavailable' : unlocked ? 'Ready to download' : 'Unlock this drop'}</h1>
        {unavailable ? <p>This link may have expired, been revoked, or the server may be offline.</p> : unlocked ?
          <><div className="file-row"><File size={20} /><span><strong>{unlocked.name}</strong><small>{fileSize(unlocked.size)}</small></span></div>
          {unlocked.files.length > 0 && <div className="drop-list request-list">{unlocked.files.map((item, index) =>
            <div className="file-row" key={index}><span><strong>{item.name}</strong><small>{fileSize(item.size)}</small></span><a className="ghost" href={downloadUrl(id, unlocked.ticket) + '?part=' + index}><ArrowDownToLine size={17} />Download</a></div>)}</div>}
          <a className="primary" href={downloadUrl(id, unlocked.ticket)}><ArrowDownToLine size={18} />{unlocked.files.length ? 'Download all as ZIP' : 'Download file'}</a>
          <button className="text-button" onClick={() => setUnlocked(null)}>Enter password again</button></> : !checking &&
          <form onSubmit={unlock}><p>Ask the sender for the drop password.</p><label htmlFor="password">Drop password</label>{passwordControl}<button className="primary" disabled={busy}><LockKeyhole size={17} />{busy ? 'Unlocking…' : 'Unlock drop'}</button></form>}
        {!checking && !unavailable && !unlocked && <div className="access-box">
          {access ? <><p>{accessState === 'declined' ? 'The sender declined your request.' : 'Your request was sent. Check back after the sender responds.'}</p><button className="text-button" onClick={checkAccess} disabled={busy}>Check request</button></>
            : asking ? <form onSubmit={ask}><label htmlFor="guest-name">Your name</label><div className="input"><input id="guest-name" required maxLength={80} value={guest} onChange={event => setGuest(event.target.value)} /></div><button className="text-button" disabled={busy}>Send access request</button></form>
            : <button className="text-button" onClick={() => setAsking(true)}>Ask for access</button>}
        </div>}
        {error && <div className="error" role="alert">{error}</div>}
      </section> : selected ? <section className="card share" key={selected.id}>
        <span className="hero-icon"><Check /></span><h1>Your drop is ready</h1>
        <p>Share the link and give your friend the password.</p>
        {qr && <div className="qr"><img src={qr} alt="QR code for this drop" width="144" height="144" /></div>}
        <div className="file-row"><File size={20} /><span><strong>{selected.name}</strong><small>{fileSize(selected.size)} · Expires {expiry(selected.expires)}</small></span></div>
        <input ref={linkField} className="share-url" aria-label="Share link" readOnly value={link} onFocus={event => event.target.select()} />
        <button className="primary" onClick={copy} disabled={!link}>{copied ? <Check size={18} /> : <Copy size={18} />}{copied ? 'Link copied' : 'Copy link'}</button>
        <button className="text-button" onClick={() => setShowActivity(!showActivity)}>{showActivity ? 'Hide activity' : 'Activity & access'}</button>
        {showActivity && <Activity id={selected.id} owner={selected.owner} />}
        <div className="share-actions"><button className="text-button" onClick={() => navigate('create')}>Create another</button><button className="text-button danger" disabled={busy} onClick={() => revoke(selected)}>Revoke link</button></div>
        {error && <div className="error" role="alert">{error}</div>}
      </section> : tab === 'shelf' ? <section className="card" key="shelf">
        <span className="hero-icon"><Archive /></span><h1>My shelf</h1><p>Manage drops created in this browser.</p>
        <div className="drop-list">{drops.filter(item => item.expires * 1000 > Date.now()).map(drop =>
          <div className="file-row" key={drop.id}><File size={20} /><span><strong>{drop.name}</strong><small>Expires {expiry(drop.expires)}</small></span><button className="ghost" onClick={() => { setSelected(drop); setShowActivity(true) }}>Open</button></div>)}
          {!drops.some(item => item.expires * 1000 > Date.now()) && <p className="empty">Your shelf is empty.</p>}
        </div><button className="primary" onClick={() => navigate('create')}><Plus size={18} />New drop</button>
      </section> : <section className="card" key="create">
        <span className="hero-icon"><PackageOpen /></span><h1>Create a drop</h1>
        <p>Leave a file for someone to pick up later.</p>
        <form onSubmit={create}>
          <input type="file" hidden multiple ref={picker} onChange={event => { choose(event.target.files); event.target.value = '' }} />
          <button type="button" className={'dropzone' + (dragging ? ' over' : '') + (files.length ? ' chosen' : '')} disabled={progress !== null}
            onClick={() => picker.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (progress === null) choose(event.dataTransfer.files) }}>
            <span className="drop-icon">{files.length ? <File size={21} /> : <Upload size={21} />}</span>
            <strong>{files.length > 1 ? files.length + ' files selected' : files[0]?.name || 'Choose files'}</strong><small>{files.length ? fileSize(files.reduce((total, item) => total + item.size, 0)) + ' · Click to change' : 'or drag and drop here · Up to ' + MAX_UPLOAD_LABEL}</small>
          </button>
          <div className="fields"><div><label htmlFor="password">Set a password</label>{passwordControl}</div>
            <ExpiryPicker value={hours} onChange={setHours} disabled={progress !== null} /></div>
          {error && <div className="error" role="alert">{error}</div>}
          {progress === null ? <button className="primary"><Plus size={19} />Create drop</button> :
            <div className="uploading"><div role="status">{progress === 100 ? 'Saving file…' : 'Uploading · ' + progress + '%'}</div><progress max={100} value={progress} /><button type="button" className="ghost" onClick={() => upload.current?.abort()}><X size={16} />Cancel</button></div>}
        </form>
      </section>}
      {!hosted && <p className="network"><Wifi size={16} />{selected ? 'Keep this computer awake while the drop is active.' : 'Connect both devices to the same Wi-Fi.'}</p>}
    </main>
  </div>
}
