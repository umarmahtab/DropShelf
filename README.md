# DropShelf

DropShelf lets you leave a file for someone to download later. Pick a file, set a password and an expiry, then share the link or QR code. The recipient can open it in their browser. You can revoke the link early from **My shelf**.

The local version runs over Wi-Fi and stores files on the host computer. The sender can close the upload tab while the host keeps running. A drop holds up to ten files totaling 5 GB. Recipients can download each file or get the whole set as a ZIP. The interface follows your device theme and includes a manual light and dark toggle.

**My shelf** shows when someone started a download and lets you approve access requests. **File requests** gives you a link that someone else can use to send you a file.

## Run locally

Install Node.js 22 or newer, pnpm, and Python 3.11 or newer. From this folder, run these commands on macOS or Linux.

```sh
pnpm install --frozen-lockfile
pnpm run build
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Open [DropShelf locally](http://127.0.0.1:8000). Connect your phone to the same Wi-Fi and scan the QR after creating a drop. See [guide.md](guide.md) for Windows commands, a walkthrough, and Vercel setup.

## How it works

Next.js renders the interface. FastAPI writes uploads to a private folder and saves metadata and salted password hashes in SQLite. A correct password or sender approval gives the recipient a download link that lasts until the drop expires. The server checks expiry and revocation on every download request. The browser that created a drop holds its revoke key.
