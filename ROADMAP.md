# TGPhotos roadmap

TGPhotos aims to make a Telegram-backed photo library comfortable to browse,
organize and back up across desktop, mobile and TV. This document records
product direction, not promised delivery dates.

## Available today

- A virtualized timeline grouped by date, with a date scrubber and adjustable density.
- Multi-selection and batch actions, including albums, favorites, archive and Trash.
- Photo viewing, video playback and a media information panel.
- Capture dates, timezone offsets, camera details and location read from supported files.
- SHA-256 duplicate detection before uploading.
- Automatic backup of selected folders while the app is running.
- A local index and thumbnail cache, with synchronization and transfer retries.
- Imports and transfers between TGPhotos and TGDrive vaults.
- Vault membership and administrator management, subject to account permissions.
- Desktop, touch and controller interfaces.

## Library organization and discovery

- [ ] Expand search across dates, camera information, places, albums and media types.
- [ ] Add a Places view for exploring geotagged media.
- [ ] Improve automatic collections such as screenshots and documents.
- [ ] Add “On this day” and other ways to rediscover older photos.
- [ ] Review visually similar photos and potential duplicates.

Existing album and search tools remain available while these improvements are
introduced incrementally.

## Backup and reliability

- [ ] Evaluate scheduled Android backup when the app is closed.
- [ ] Improve visibility into background backup restrictions and recovery.
- [ ] Continue testing resumable uploads and duplicate handling under interruption.

Closed-app Android backup needs separate background execution support. Keeping
the current app running remains the supported backup workflow.

## Later exploration

- [ ] People and face grouping, with clear privacy controls.
- [ ] A locked folder experience.
- [ ] Basic photo editing.
- [ ] Stacks for related or similar media.

## Contributing ideas

Describe the task you want to accomplish, your platform, and where the current
flow gets in the way. Screenshots and concrete examples help prioritize changes
that improve everyday use.
