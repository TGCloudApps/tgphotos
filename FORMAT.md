# TGPhotos vault format (version 1)

TGPhotos vaults use the channel title `<Name>.tgphotos` and the caption markers
`#tgphotos_vault`, `#tgphotos_ops` and `#tgphotos_snapshot`.

## Channel and index

The vault is a private Telegram channel. A pinned text manifest identifies the
application, format version and vault ID, and points to the latest snapshot.
The channel title alone does not make it a valid vault.

The channel stores four kinds of messages:

| Message | Contents |
| --- | --- |
| Manifest | Pinned text with the vault identity and snapshot pointer. |
| Operation batch | Gzip-compressed JSON with row updates and deletion tombstones. |
| Snapshot | Gzip-compressed JSON containing the current index and retained tombstones. |
| Content | File pieces and thumbnail documents referenced by the index. |

Documents use random extensionless names and `application/octet-stream`. Their
real names, types and organization live in the index. Operation batches and
snapshots are identified by their captions.

Each update identifies an entity and row, with a full-row upsert or a deletion
tombstone and a hybrid logical clock (`hlc`). The greatest clock wins for each
row. Reapplying an update is harmless. A new device reads the snapshot, then
replays newer batches; its local database is a cache of that state.

The manifest's `encryption` field identifies whether payloads are plain or use
`xchacha20poly1305`. Encrypted vaults wrap a random master key with an Argon2id
password-derived key. The channel title, manifest and message sizes remain
visible. Ordinary Telegram channel storage itself is not Secret Chat encryption.

## `media` entity

One row represents a photo or video. Its `id` is a ULID shared across devices.

```jsonc
{
  "name": "IMG_20240131_123456.jpg",
  "mime": "image/jpeg",
  "size": 3481331,
  "pieces": [{ "msg": 1234, "size": 3481331 }],
  "sha256": "9f86d0…",                    // Optional whole-file content hash, hex
  "thumb": { "msg": 1240, "size": 18231 }, // Optional JPEG, at most 480 px
  "taken": 1706715296000,                 // Capture time, UTC milliseconds
  "tz": -180,                             // Optional capture-time offset, minutes
  "w": 4000, "h": 3000,                   // Optional dimensions after orientation
  "duration": 61.4,                       // Optional video duration, seconds
  "camera": {                             // Optional camera metadata
    "make": "Google", "model": "Pixel 8", "lens": "…",
    "f": 1.7, "exposure": 0.008, "iso": 64, "focal": 6.9
  },
  "gps": [-23.5505, -46.6333],            // Optional latitude and longitude
  "fav": true,                            // Missing means false
  "archived": true,                       // Missing means false
  "trashed": 1706800000000,               // Optional trash timestamp, milliseconds
  "origin": "DCIM/Camera",                // Optional source device folder
  "motion": 2345678,                      // Optional appended MP4 length in bytes
  "added": 1706715300000,                 // Upload time, milliseconds
  "mtime": 1706715300000                  // Last row change, milliseconds
}
```

- **Content:** `pieces` lists channel documents in file order. Pieces contain up
  to 64 MiB; concatenate their plaintext content to reconstruct the original.
- **Capture time:** `taken` comes from EXIF `DateTimeOriginal` and
  `OffsetTimeOriginal` for images, or `mvhd`/`com.apple.quicktime.creationdate`
  for videos. Without embedded dates, the app tries known filename patterns,
  then the file's modification time. A date without an offset uses the uploading
  device's timezone.
- **Thumbnail:** `thumb` references a separate JPEG. A device that can generate
  and publish missing thumbnails can supply it; viewers may also cache thumbnails locally.
- **Motion photo:** `motion` is the length of the MP4 appended to the image.
  Zero means the file was checked and is an ordinary photo.
- **Trash:** `trashed` marks media for deletion. After 30 days, a client with
  the required write/delete permissions can publish the deletion and remove
  unreferenced channel documents.
- **Duplicates:** uploads calculate SHA-256 before sending. If the content is
  already in the vault, reuse it instead of uploading again. Restore an existing
  trashed item when needed and add it to the destination album.

## `album` entity

```json
{"name":"Trip","cover":"01J9Z…","ctime":1706715300000,"mtime":1706715300000}
```

`cover` optionally identifies the cover media by ULID. Without it, the most
recent media supplies the cover.

## `album_item` entity

An album/media pair has its own row, so concurrent changes do not replace an
entire album membership list. Its deterministic ID is `<album>:<media>`;
adding the same pair on two devices converges to one row.

```json
{"album":"01J9Z…","media":"01JA0…","added":1706715300000}
```

Removing media from an album publishes a tombstone for that membership.
Deleting an album removes its memberships and keeps the media. Permanently
deleting media removes its memberships too.
