# Phone entries are offline-first and the server never rejects them for stock reasons

Issues mostly happen at Event booths away from the office Wi-Fi, so the phone app saves every Count and Movement locally and syncs it when it next reaches the server. An entry records something that already happened physically, so the server accepts it even if it drives a Stock Level negative. Negative levels are flagged for an Admin to resolve. A Count is applied at the time it was counted, not when it synced, so Movements recorded after that time still apply on top of it.

## Considered Options

- **Online only.** Rejected because it fails exactly where Issues happen (off-site booths).
- **Reject entries that would make stock negative.** Rejected because two offline phones can legitimately Issue the same last units. Rejecting one would lose a real event and hide the discrepancy.

## Consequences

- The phone's displayed Stock Levels are only as fresh as its last sync, so the app must show when it last synced.
- Each entry needs a time recorded on the phone (when it happened) as well as the time it synced, and the server orders entries by when they happened.
