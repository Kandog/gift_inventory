# TypeScript throughout, with a single SQLite-backed server on one Windows PC

The system runs on one always-on Windows PC on a private network: a Node.js (Fastify) process serves the API and the React admin dashboard, and stores data in SQLite (Node's built-in `node:sqlite`, so there is no native driver to compile). It runs unattended as a Task Scheduler startup task (`scripts/install-server.ps1`). That gives start-at-boot, restart-on-failure and a chosen run-as account without shipping a third-party service wrapper. The account matters because nightly backups write to a network share. The phone app is React Native (Expo) so one codebase covers Android and iOS. Using TypeScript everywhere lets the phone and server share the domain types and sync logic, which matters because of offline-first sync (ADR 0001). SQLite was chosen over a database server because the data volume is team-sized and a single file is trivial to install and back up.

## Considered Options

- **Flutter for mobile.** Equally capable, but Dart would prevent sharing code with the server.
- **PostgreSQL / SQL Server.** Unnecessary operational overhead for one PC and a small team.
