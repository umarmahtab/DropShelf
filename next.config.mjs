if (process.env.VERCEL && !process.env.NEXT_PUBLIC_API_URL?.startsWith("https://")) {
  throw new Error("Set NEXT_PUBLIC_API_URL to your persistent HTTPS Python backend before deploying.")
}
export default { output: "export", trailingSlash: true, devIndicators: false, experimental: { useTypeScriptCli: false } }
