# Speed Tap

A real-time, no-login reaction game for 2–8 players. Share a five-character room code, wait for the green target, and race to tap first across five rounds.

## Run locally

Requires Node.js 18 or newer. There are no runtime dependencies.

```sh
npm start
```

Open `http://localhost:3000` in a browser. To play on a second device on the same Wi-Fi, open `http://<your-computer-lan-address>:3000` on that device and use the room code.

## Deploy to a public URL

This is a single Node web service. It serves the browser app and handles WebSocket rooms from the same origin, so no separate frontend or environment variables are required.

For Render, put this folder and the adjacent `render.yaml` in a Git repository. In Render, choose **New → Blueprint** and connect that repository; the Blueprint configures the service root, Node runtime, start command, and health check. Render supplies a public `onrender.com` address when the service is live. Alternatively, create a Web Service manually with `outputs/speed-tap` as its root directory, `npm install` as the build command, and `npm start` as the start command.

Rooms live in server memory and are removed after four hours with no connected players. Keep a single running server instance so all players in a room reach the same authoritative game state. A server restart or redeploy clears active rooms; players can create a fresh room and share a new code.
