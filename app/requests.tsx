'use client'

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from './upload-limit'

import { useEffect, useState, type FormEvent } from 'react'
import { ArrowDownToLine, Inbox } from 'lucide-react'

const api = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '') + '/api'
export async function call<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(api + path, options)
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Please try again.')
  return body
}
export const auth = (key: string) => ({ Authorization: 'Bearer ' + key })
export const label = (name: string) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
export const downloadUrl = (id: string, ticket: string) => api + '/drops/' + id + '/file/' + ticket

type Inbox = { id: string; title: string; owner: string; expires: number }
type Submission = { id: string; name: string; size: number }
type Item = { id: string; name: string; state: string }

export function Activity({ id, owner }: { id: string; owner: string }) {
  const [activity, setActivity] = useState<{ count: number; latest: number | null; requests: Item[] }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function refresh() {
    try {
      setActivity(await call('/drops/' + id + '/activity', { headers: auth(owner) }))
      setError('')
    } catch (failure) { setError((failure as Error).message) }
  }
  useEffect(() => { void refresh() }, [id, owner])
  async function decide(key: string, approve: boolean) {
    setBusy(true)
    try {
      await call('/drops/' + id + '/access/' + key + '/decision?approve=' + approve, { method: 'POST', headers: auth(owner) })
      await refresh()
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="activity">
    <div className="section-heading"><h2>Pickup activity</h2><button className="ghost" onClick={refresh}>Refresh</button></div>
    {activity && <><p>{activity.count ? activity.count + ' pickup sessions · Last started ' + new Date(activity.latest! * 1000).toLocaleString() : 'No downloads started yet.'}</p>
    <h2>Access requests</h2>
    {activity.requests.length === 0 && <p>No access requests yet.</p>}
    <div className="drop-list">{activity.requests.map(item => <div className="file-row" key={item.id}>
      <span><strong>{item.name}</strong><small>{item.state}</small></span>
      {item.state === 'pending' && <><button className="ghost" disabled={busy} onClick={() => decide(item.id, false)}>Decline</button><button className="ghost" disabled={busy} onClick={() => decide(item.id, true)}>Approve</button></>}
    </div>)}</div></>}
    {error && <div className="error" role="alert">{error}</div>}
  </div>
}

export function FileRequests({ origin, receive = false }: { origin: string; receive?: boolean }) {
  const [inboxes, setInboxes] = useState<Inbox[]>([])
  const [current, setCurrent] = useState<Inbox>()
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [files, setFiles] = useState<Submission[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [ready, setReady] = useState(false)
  const [copied, setCopied] = useState(false)
  const [links, setLinks] = useState<Record<string, string>>({})
  const share = current ? origin + '/request/?id=' + current.id : ''

  useEffect(() => {
    if (receive) {
      const requestId = new URLSearchParams(location.search).get('id') || ''
      if (!/^[\w-]{24}$/.test(requestId)) { setError('This request link is invalid.'); return }
      setId(requestId)
      call<{title: string}>('/inboxes/' + requestId).then(data => { setTitle(data.title); setReady(true) })
        .catch(failure => setError(failure.message))
    } else {
      try { setInboxes(JSON.parse(localStorage.getItem('dropshelf.inboxes') || '[]')) } catch { setInboxes([]) }
    }
  }, [receive])

  async function refresh(inbox: Inbox) {
    setError('')
    try { setFiles(await call('/inboxes/' + inbox.id + '/files', { headers: auth(inbox.owner) })) }
    catch (failure) { setError((failure as Error).message) }
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const inbox = await call<Inbox>('/inboxes', label(title))
      const next = [inbox, ...inboxes]
      localStorage.setItem('dropshelf.inboxes', JSON.stringify(next))
      setInboxes(next)
      open(inbox)
      setTitle('')
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }

  function open(inbox: Inbox) {
    setCurrent(inbox)
    setFiles([])
    setLinks({})
    setCopied(false)
    void refresh(inbox)
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const file = new FormData(event.currentTarget).get('submission')
    if (!(file instanceof File)) return
    if (file.size > MAX_UPLOAD_BYTES) { setError('Choose a file up to ' + MAX_UPLOAD_LABEL + '.'); return }
    setBusy(true)
    setError('')
    try {
      await call('/inboxes/' + id + '/files', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) } })
      setSent(true)
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(false) }
  }

  async function prepare(file: Submission) {
    if (!current) return
    try {
      const result = await call<{ticket: string}>('/inboxes/' + current.id + '/files/' + file.id, { method: 'POST', headers: auth(current.owner) })
      setLinks(previous => ({ ...previous, [file.id]: downloadUrl(file.id, result.ticket) }))
    } catch (failure) { setError((failure as Error).message) }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(share)
      setCopied(true)
    } catch {
      document.querySelector<HTMLInputElement>('#inbox-link')?.select()
      setCopied(document.execCommand('copy'))
    }
  }

  return <section className="card">
    <span className="hero-icon"><Inbox /></span><h1>{receive ? title || 'File request' : current?.title || 'File requests'}</h1>
    {receive ? ready && (sent ? <p role="status">File sent.</p> : <form onSubmit={send}>
      <p>Send a file to the person who shared this link.</p><label htmlFor="submission">Choose a file</label>
      <input id="submission" className="share-url" type="file" name="submission" required disabled={busy} />
      <button className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send file'}</button>
    </form>) : current ? <>
      <p>Anyone with this link can send you a file until {new Date(current.expires * 1000).toLocaleString()}.</p>
      <label htmlFor="inbox-link">Request link</label><input className="share-url" id="inbox-link" readOnly value={share} onFocus={event => event.currentTarget.select()} />
      <button className="primary" onClick={copy}>{copied ? 'Link copied' : 'Copy request link'}</button>
      <div className="section-heading"><h2>Received files</h2><button className="ghost" onClick={() => refresh(current)}>Refresh</button></div>
      {files.length === 0 && <p>No files received yet.</p>}
      <div className="drop-list">{files.map(file => <div className="file-row" key={file.id}><span><strong>{file.name}</strong></span>
        {links[file.id] ? <a className="ghost" href={links[file.id]}><ArrowDownToLine size={16} />Download</a> : <button className="ghost" onClick={() => prepare(file)}>Get file</button>}
      </div>)}</div><button className="text-button" onClick={() => { setCurrent(undefined); setError('') }}>All requests</button>
    </> : <>
      <p>Create a link so someone can send you a file.</p>
      <form onSubmit={create}><label htmlFor="request-title">Request title</label><div className="input"><input id="request-title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={80} placeholder="Project footage" /></div>
        <button className="primary" disabled={busy}>Create request link</button></form>
      <div className="drop-list request-list">{inboxes.filter(inbox => inbox.expires * 1000 > Date.now()).map(inbox =>
        <div className="file-row" key={inbox.id}><span><strong>{inbox.title}</strong></span><button className="ghost" onClick={() => open(inbox)}>Open</button></div>)}</div>
    </>}
    {error && <div className="error" role="alert">{error}</div>}
  </section>
}
