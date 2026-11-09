# Third-party notices

This plugin is licensed under AGPL-3.0-only. The complete license is in `LICENSE`.

The NetEase API protocol and data mappings are adapted from:

- Repository: https://github.com/sogud/mygo-cloudmusic
- Original project: https://github.com/egoist/mygo-cloudmusic
- Upstream author: egoist and contributors; preserved fork: sogud.
- Reference commit: `b13f52a2a2ff0746502b85b9c4c7fa1e86a1c385`.
- Files consulted: `internal/netease/eapi.go`, `auth.go`, `netease.go`, `catalog.go`, `podcast.go`, `subscriptions.go`.
- Upstream license: GNU Affero General Public License version 3.

Modifications made on 2026-11-06: ported Go requests to MyGo Music's JavaScript
plugin API; replaced the HTTP cookie jar and keychain integration with explicit
cookie handling and the host's private storage; added host data conversion,
quality mapping, bounded playlist loading, session invalidation, domain
validation, and tests. No Go code or upstream binaries are included in the plugin.

Host API reference: https://github.com/egoist/mygo-music at
`9c7f629ef202d66ee064ee9128c34b169b5e7215` (MyGo Music 0.1.6), especially its
README, `examples/demo-plugin`, `internal/music/music.go`, and `internal/plugin`.
The host itself is licensed under AGPL-3.0 and is distributed separately.

NetEase Cloud Music names and content belong to their respective owners. This
project is not an official NetEase or MyGo Music release. The license covers
this plugin's source, not music content or service access rights.

Recommendation endpoint shapes and FM modes were also checked against
AkinoKaede/mygo-music-netease-cloud-music, commit
`c988df7f4d787c1a133ba66e1f4f9dd71a2650cf` (`index.js`, AGPL-3.0),
and the public playlist metadata returned by NetEase for private radar.

Modifications made on 2026-11-07: added read-only comment pages, subscribed
podcasts and episode browsing, and kept program identity separate from its
audio ID for playback and comments; retained server cookie updates on
transient playback refusals for the existing bounded retry.

Playlist track editing is adapted from jieye666's contribution in
https://github.com/sogud/mygo-music-netease/pull/6, commit
`29c6cffd6990d527a3d9e46757824dc0f6903881` (AGPL-3.0-only), with
current-session checks, podcast ID rejection, and conservative duplicate retry.

The unexposed heart-mode candidate is adapted from `HeartMode` in
`internal/netease/radio.go` at the same preserved upstream commit. Its request
uses NetEase's intelligence endpoint; live continuation and account validation
remain pending, so the candidate is not listed in the plugin's navigation.

## 网易云音乐 Plus 的修改

本项目 `VenusLuna/mygo-music-netease-plus` 基于 https://github.com/sogud/mygo-music-netease 的 v0.1.7
（提交 `2b7f726`，AGPL-3.0-only）。原项目的提交历史、许可证和上述所有来源说明均保留。

2026-11-09 的修改：播放地址改为网页端接口优先、桌面端 eapi 回退（拒绝 `-460`、无权限或只返回试听时）；歌单上限从 1000 首提高到
10000 首，歌曲详情改为 200 首一批的有限并发加载并加入短期缓存；插件 ID 改为 `netease-plus`，以便和原版共存。
