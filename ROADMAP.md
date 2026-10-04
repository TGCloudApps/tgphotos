# ROADMAP — TGPhotos (definitivo)

Galeria de fotos e vídeos sobre o Telegram, na arquitetura do TGDrive:
Tauri 2 + interface web, núcleo Rust, vaults próprios (`<Nome>.tgphotos`) com
índice snapshot + oplog (`crates/tg-core/FORMAT.md`), cifragem desligada por
ora (`encryption: "none"` reservado), duas cascas (celular / desktop) e
navigator com gates de voltar.

O app anterior (Flutter + FRB) está em `../tgphotos-legacy` e é a referência
de recursos. Fontes do inventário: tgphotos-legacy, teledisk/appphotos e o
Google Fotos atual (Fotos · Coleções · Busca).

## Código compartilhado com o TGDrive

Nada de copiar: o que os dois apps têm em comum sai do TGDrive para pacotes.

| Pacote | Conteúdo |
|---|---|
| `crates/tg-core` | Telegram, sessão, canal, upload/download em partes, servidor de bytes, vault, sync (já existe) |
| `crates/tg-app` (novo) | Peças Tauri genéricas: gerenciador de vaults, transferências (fila persistida, 64 MiB, sha256, retomada), rotas de miniatura, `/status` |
| `packages/tg-ui` (novo) | Tokens/CSS, navigator, ponte Android, avisos, Player, Lightbox, Sheet, componentes de desktop (menu, diálogo, botões), Login, Vaults, Transferências, gerador de miniaturas |
| Kotlin (`TGAndroid`, serviço) | Mesmos arquivos nos dois apps (pacote diferente) |

## Entidades do vault (FORMAT do TGPhotos)

- `media`: nome, mime, tamanho, peças, sha256, miniatura, `taken_at` (+ fuso),
  largura/altura, duração, câmera (marca, modelo, lente, f, exposição, ISO,
  focal), GPS, favorito, arquivado, lixeira, origem (pasta do aparelho).
- `album`: nome, capa, criação. `album_item`: (álbum, mídia, posição) — LWW
  por item, para dois aparelhos editarem o mesmo álbum sem conflito.
- Todo documento no canal é opaco (nome aleatório, octet-stream, como arquivo).

## Fases

- [x] **0. Base compartilhada** — `crates/tg-app` (vaults, transferências,
  rotas, comandos comuns via `tg_app::commands!`, `Core::start`) e
  `packages/tg-ui` (tokens, navigator, boot, login, vaults, player,
  lightbox genérico, transferências, folhas, menus, avisos). O TGDrive usa os
  dois; workspace Cargo e npm na raiz.
- [x] **1. Esqueleto** — `com.tgcloud.tgphotos`, vaults `.tgphotos`, entidades
  `media`/`album`/`album_item` (FORMAT.md), transferências e miniaturas.
- [x] **2. Linha do tempo** — layout calculado em JS e virtualizado (linhas
  justificadas no desktop, grade quadrada no celular, seções por dia ou mês),
  scrubber (trilho com anos / alça arrastável), densidade por pinça e
  Ctrl+roda, seleção (toque longo, círculo, Ctrl/Shift+clique, dia inteiro),
  ações em lote, lightbox comum com favoritar/álbum/arquivar/lixeira e painel
  de informações com câmera, exposição e minimapa (OSM); favoritos, vídeos,
  arquivo, lixeira com retenção de 30 dias; prévia de vídeo ao passar o mouse.
- [x] **3. Envio e metadados** — EXIF (data + fuso, câmera, lente, exposição,
  GPS, orientação), vídeo (`mvhd`, `tkhd`, `©xyz`, chaves da Apple), data pelo
  nome do arquivo, dedup por sha256 *antes* de subir (vale para o TGDrive
  também), pasta de origem.
- [x] **4. Backup automático** — desktop: pastas observadas (varridas ao abrir
  e a cada 5 min). Android: pastas do aparelho pelo MediaStore (permissões de
  mídia + localização da mídia), ao abrir, ao voltar e quando o sistema avisa
  de mídia nova; o serviço em primeiro plano segura o envio.
  - [ ] Com o app fechado (WorkManager + núcleo Rust sem interface): só se o
    backup com o app vivo não bastar. Exige abrir arquivos por descritor
    passado pelo Kotlin (sem o `AppHandle`) e uma entrada JNI própria.
- [ ] **5. Coleções e busca** — álbuns (criar, capa, ordem), Favoritos,
  Lugares (mapa), Vídeos, Capturas de tela, Arquivo; busca por nome, data,
  câmera, lugar, álbum, tipo; "Neste dia" e destaques; duplicadas (dHash).
- [x] **Offline-first** — sessão local (sem perguntar ao servidor para abrir),
  vault aberto do cache com sync em segundo plano, estado de conexão
  (`tg_app::Net`, teste a cada 10 s offline), envios/downloads em "aguardando
  conexão" que retomam sozinhos, miniaturas pré-baixadas para o cache,
  originais locais (`/local/<id>`) e a galeria do aparelho na linha do tempo
  (Câmera + pastas com backup), com selo "Offline".
- [x] **6. Importar entre apps** — TGPhotos importa fotos/vídeos de vaults do
  TGDrive (por pasta, com álbum de destino, pula o que já tem pelo sha256) e
  o TGDrive importa do TGPhotos (tudo ou um álbum, numa pasta nova). As
  mensagens são encaminhadas entre os canais (`tg_core::sync::read_vault` lê o
  índice do outro sem abri-lo).
- [ ] **7. Depois** — pessoas (SCRFD + ArcFace via `ort`, agrupamento),
  pasta trancada (precisa da cifragem), edição básica, importar vaults do
  tgphotos-legacy (cifrados, formato antigo).

## Preservar do legado

Login com sessão persistida · vaults próprios · envio em partes retomável +
dedup sha256 · servidor local com Range · EXIF/GPS/vídeo + datas · grade
justificada por dia + scrubber · seleção e lote · lightbox com painel de
informações e minimapa · player com atalhos · álbuns (CRUD, capa, ordem) e
favoritos · lixeira com retenção e limpeza remota · busca por nome · fila de
tarefas visível. Pasta segura e cifragem voltam na fase 7.

## Do appphotos / Google Fotos

Prévia de vídeo ao passar o mouse · transição da miniatura para o lightbox ·
"Neste dia" · revisão de duplicadas · pilhas de parecidas (depois) · Lugares
em mapa · coleções automáticas (vídeos, capturas, documentos).
