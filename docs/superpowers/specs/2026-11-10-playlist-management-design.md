# 完整歌单管理设计

日期：2026-11-10
状态：已获用户批准

## 目标

让网易云音乐 Plus 填满 MyGo Music 已有的歌单管理能力：创建、重命名、删除、收藏/取消收藏歌单，以及添加、移除和移动歌单内歌曲。只修改插件，复用宿主现有界面。

## 范围与约束

- 新增 `createPlaylist`、`renamePlaylist`、`deletePlaylist`、`savePlaylist`、`movePlaylistTrack`，保留现有 `addToPlaylist`、`removeFromPlaylist`。
- 创建接口只接收宿主提供的名称，创建普通歌单；不新增宿主没有的简介、封面、标签或隐私设置界面。
- 所有写操作要求登录，校验 ID、名称和排序位置；失败时抛出错误，不伪装成功。
- 复用现有 EAPI、会话、CSRF、账号世代检查和重复歌曲处理，不引入依赖。

## 方案选择

- **采用：只扩展插件。** 宿主已提供全部所需 UI 和调用接口，改动最小。
- **不采用：只补创建和删除。** 仍会缺少排序与收藏，不符合完整管理目标。
- **不采用：修改宿主或自制管理页面。** 会重复现有界面并扩大维护范围。

## 接口实现

- 创建：EAPI `/api/playlist/create`，参数 `name`、`privacy: 0`、`type: "NORMAL"`，返回宿主 `Playlist`。
- 重命名：EAPI `/api/playlist/update/name`，参数 `id`、`name`。
- 删除：EAPI `/api/playlist/remove`，参数 `ids` 为仅含目标数字 ID 的 JSON 数组。
- 收藏/取消收藏：EAPI `/api/playlist/subscribe` 或 `/api/playlist/unsubscribe`，参数 `id`。
- 添加/移除：保留 `/api/playlist/manipulate/tracks` 的 `add`/`del` 逻辑。
- 移动歌曲：读取 `/api/v6/playlist/detail` 的完整 `trackIds`，校验 `from`、`to`，本地执行一次移动，再以 `op: "update"` 提交完整 ID 顺序。不能用删除再添加模拟。

## 一致性与测试

- 只有确认 `trackIds` 完整时才允许排序；账号或会话在读取与提交之间变化时停止。
- 覆盖创建、重命名、删除、收藏/取消收藏、向上/向下移动、原位置移动、空列表和越界。
- 覆盖未登录、非法名称/ID、接口失败，以及现有添加、移除和重复歌曲行为回归。
- 运行 `npm run check`、`npm test` 和 `git diff --check`；真实账号在线写操作仍需在宿主中验收。
