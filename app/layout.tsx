import type { Metadata } from 'next'
import './style.css'

export const metadata: Metadata = { title: 'DropShelf', description: 'Password-protected file sharing' }

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body>{children}</body></html>
}
