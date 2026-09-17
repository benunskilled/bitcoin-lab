# Running it outside Umbrel

On Umbrel there is nothing to read: the store installs it. This is for everywhere
else.

A normal multi-container Docker Compose stack; the Umbrel-specific wiring lives
only in the packaging repo.
 A normal multi-container Docker Compose stack; the
Umbrel-specific wiring lives only in the packaging repo.

```sh
docker compose -f docker-compose.dev.yml up --build
bash test/regtest-generate.sh   # mine a regtest block
docker compose -f docker-compose.dev.yml logs -f relay-profiler
```

Dashboard: http://localhost:8788

The dashboard has no authentication of its own — on Umbrel it sits behind the app
proxy, which is what asks for your password. Standalone, do not put port 8788 on
a network you do not trust.

Tests:

```sh
npm ci
npm test
```

Every environment variable is listed in
[configuration.md](configuration.md). There are no config files to
hand-edit.


---

[← back to the README](../README.md)
