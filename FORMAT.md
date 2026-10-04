# Formato do vault do TGPhotos (v1)

O contêiner (manifesto, lotes de ops, snapshots, regras de mescla) está em
`../crates/tg-core/FORMAT.md`. Aqui fica só o que é do TGPhotos. O canal se
chama `<Nome>.tgphotos`, e as marcas no canal usam o prefixo `#tgphotos_`
(`#tgphotos_vault`, `#tgphotos_ops`, `#tgphotos_snapshot`).

Todo documento no canal é opaco: nome aleatório, sem extensão,
`application/octet-stream`, enviado como arquivo. O que cada um é está só no
índice.

## Entidade `media`

Uma linha por foto ou vídeo. `id` é um ULID estável entre aparelhos.

```json
{
  "name": "IMG_20240131_123456.jpg",
  "mime": "image/jpeg",
  "size": 3481331,
  "pieces": [{ "msg": 1234, "size": 3481331 }],
  "sha256": "9f86d0…",            // opcional; hex do conteúdo inteiro
  "thumb": { "msg": 1240, "size": 18231 }, // opcional; JPEG ≤ 480 px
  "taken": 1706715296000,         // ms UTC da captura
  "tz": -180,                     // opcional; fuso da captura em minutos
  "w": 4000, "h": 3000,           // opcional; já com a orientação aplicada
  "duration": 61.4,               // opcional; segundos (vídeo)
  "camera": {                     // opcional
    "make": "Google", "model": "Pixel 8", "lens": "…",
    "f": 1.7, "exposure": 0.008, "iso": 64, "focal": 6.9
  },
  "gps": [-23.5505, -46.6333],    // opcional; [lat, lon]
  "fav": true,                    // ausente = false
  "archived": true,               // ausente = false
  "trashed": 1706800000000,       // opcional; ms em que foi para a lixeira
  "origin": "DCIM/Camera",        // opcional; pasta de origem no aparelho
  "added": 1706715300000,         // ms do envio
  "mtime": 1706715300000          // ms da última mudança na linha
}
```

- **Conteúdo** como no TGDrive: `pieces` em ordem, partes de 64 MiB.
- **`taken`** vem do arquivo: EXIF (`DateTimeOriginal` + `OffsetTimeOriginal`)
  nas imagens; `mvhd` ou `com.apple.quicktime.creationdate` nos vídeos. Sem
  data embutida, o nome do arquivo (`IMG_20240131_123456`, `PXL_…`,
  `Screenshot_2024-01-31-…`, `IMG-20240131-WA0001`) e, por último, a data de
  modificação do arquivo. Hora sem fuso é lida no fuso do aparelho que enviou.
- **`thumb`** como no TGDrive (gerada por quem viu a mídia primeiro).
- **Lixeira** é `trashed`; depois de 30 dias o aparelho que abrir o vault
  apaga de vez (`del` + mensagens órfãs saem do canal).
- **Duplicadas:** o envio calcula o sha256 antes de subir; se o vault já tem
  o conteúdo, nada sobe (a mídia existente volta da lixeira, se for o caso, e
  entra no álbum de destino).

## Entidade `album`

```json
{ "name": "Viagem", "cover": "01J9Z…", "ctime": 1706715300000, "mtime": 1706715300000 }
```

`cover` é o ULID da mídia da capa (opcional; sem ela, vale a mais recente).

## Entidade `album_item`

Um item por par álbum × mídia, para dois aparelhos mexerem no mesmo álbum sem
um apagar o que o outro pôs (LWW por item, não pelo álbum inteiro). O `id` é
determinístico, `"<album>:<media>"`, então pôr a mesma mídia no mesmo álbum em
dois aparelhos converge para a mesma linha.

```json
{ "album": "01J9Z…", "media": "01JA0…", "added": 1706715300000 }
```

Tirar do álbum é `del` do item. Apagar o álbum apaga os itens (as mídias
ficam). Apagar a mídia de vez apaga os itens dela.
