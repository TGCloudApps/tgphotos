# TGPhotos

Fotos e vídeos sobre o Telegram: Tauri 2 + interface web (React/Vite/Tailwind)
+ núcleo Rust (`crates/tg-core`, `crates/tg-app`), interface comum em
`packages/tg-ui`. Vaults próprios (`<Nome>.tgphotos`), formato em
[FORMAT.md](FORMAT.md), planos em [ROADMAP.md](ROADMAP.md). O app antigo
(Flutter) está em `../tgphotos-legacy`.

## Rodar

Credenciais da API do Telegram em `config/telegram.local.toml` (fora do git):

```toml
api_id = 123
api_hash = "…"
```

```sh
npm install            # na raiz do tgcloud (workspaces)
npm run tauri dev      # desktop
npm run dev            # só a interface no navegador, com backend simulado
                       # (?shell=mobile|desktop força a casca)
npm run android:release  # APK arm64 assinado: release/TGPhotos-release-arm64.apk
```

O build Android usa um `target` próprio (`../target/android-tgphotos`): o
Kotlin gerado pelo Tauri leva o pacote do app e não pode ser dividido com o
TGDrive.
