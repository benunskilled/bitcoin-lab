# Bitcoin Lab development

## Local regtest setup

For local development and testing, this repository includes a Docker Compose setup with Bitcoin Lab and a Bitcoin Core regtest node. It lets you generate test blocks and follow how the app records them.

From a checkout of this repository, with Docker Compose installed:

```sh
docker compose -f docker-compose.dev.yml up --build
```

Open `http://localhost:8788` to view the dashboard.

In another terminal, generate a test block and follow the relay profiler's output:

```sh
bash test/regtest-generate.sh
docker compose -f docker-compose.dev.yml logs -f relay-profiler
```

The Compose file defaults to the third-party `ruimarinho/bitcoin-core:23` image. Set `BITCOIND_IMAGE` to a suitable image when testing behaviour specific to another Core version.

The standalone dashboard has no built-in login. Keep it on a trusted network or place it behind an authenticated proxy. On Umbrel, the app proxy handles authentication.

## Unit tests

With Node.js 22 or later installed:

```sh
npm ci
npm test
```

See [Configuration](docs/configuration.md) for environment variables and [Architecture](docs/architecture.md) for the process and storage design.

---

[← Back to the README](README.md)
