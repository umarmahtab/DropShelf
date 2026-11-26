# DropShelf guide

## Run and try it

Follow the README to install dependencies and build the interface. On Windows PowerShell, create the virtual environment with `py -m venv .venv`. Use ` .venv\Scripts\python.exe` in place of `.venv/bin/python` for the install and server commands.

1. Open DropShelf on the host laptop.
2. Choose a file, set a password, and pick an expiry.
3. Create the drop. Share the link or let a friend scan the QR code. Give them the password separately.
4. On the second device, open the link, unlock the drop, and download the file.
5. On the host, open **My shelf**, select the file, and revoke the link. Opening it again should show that the drop is unavailable.

Both devices need to be on a network where they can reach each other. If the phone cannot connect, open the app on the laptop using its Wi-Fi IP address and recreate the drop link. If the network isolates devices, try a hotspot that allows device-to-device traffic. Allow inbound port 8000 on the host's private network if its firewall blocks connections.

## Share several files and manage requests

- Select up to ten files in the picker or drag them in together. The 5 GB limit applies to the whole drop. The recipient can choose individual files or **Download all as ZIP**.
- A recipient can select **Ask for access** and enter their name. Open the drop under **My shelf** and approve or decline the request. The recipient checks the decision from the same browser and can download after approval.
- **My shelf** counts pickup sessions and shows when the latest one started. A browser that supports resuming downloads can continue a partial transfer while the drop is active.
- Open **File requests**, give the request a title, and share its link. Anyone with that link can submit a file for seven days. Open the request in the browser that created it to see and download submissions. The server removes the uploads when the request expires.

## Files and expiry

Uploaded copies live under `data/uploads/`, alongside the SQLite database in `data/`. DropShelf deletes its stored copy when you revoke a drop. The server sweeps expired copies on startup and every 30 seconds. The download stops being available at the expiry time. Keep the laptop awake and the server running for local pickup.

The shelf is stored in the sender's browser. Clearing site data removes your management keys. Existing drops continue to expire on schedule. The server defaults to a total of 20 GiB in its storage quota. Change this with `DROPSHELF_QUOTA_MIB` if needed. Creating a 5 GB multi-file drop can temporarily use about 15 GB of free disk space while the server builds the ZIP.

## Deploy the frontend to Vercel

The local version keeps the original same-Wi-Fi behavior. The Vercel frontend uses an HTTPS FastAPI backend on a separate host. In that setup, files are stored on the backend host and recipients with the link and password can connect over the internet.

1. Run the Python backend on a host with a persistent disk. Set `DROPSHELF_DATA` to a dedicated directory on that disk. Run one Uvicorn worker with `python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000`.
2. Give the backend an HTTPS URL using your host's HTTPS proxy. Set `DROPSHELF_ORIGINS` in the backend environment to the frontend's exact origin, such as `https://dropshelf.vercel.app`. Restart the backend after changing it.
3. Import the GitHub repo into Vercel. Set the project root to the folder containing `package.json` and `vercel.json`. Set `NEXT_PUBLIC_API_URL` to the backend's HTTPS origin and deploy.
4. Verify an upload and download on the deployed domain. If you use a preview domain, add its exact origin using a comma-separated list in `DROPSHELF_ORIGINS`.

The browser transfers files directly with FastAPI. Vercel serves the built frontend and does not store the files. Set your backend proxy's request size allowance to at least 5 GB, and allow upload and download time for that size. Serve the public backend with HTTPS. For local HTTP, use a trusted Wi-Fi network.
