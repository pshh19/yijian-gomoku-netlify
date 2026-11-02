# 弈间五子棋 · Netlify 访客与账号版

打开网页即可直接玩：访客不用注册、登录或调用账号接口，所有难度、悔棋和对局历史都可用；访客棋谱只保存在当前浏览器。点顶部红色「点击登录」后，先输入站点授权码，验证通过才可创建账号或登录。登录后的每局棋谱会同时保存到当前浏览器和 Netlify Blobs 云端，云端副本可跨设备读取和复盘。

## 部署到 Netlify Free

Netlify Free 每月提供 300 credits，有硬上限；用完后站点会暂停到下个计费周期。访客对局不会请求 Functions 或 Blobs，只有打开账号授权、登录注册、读取或保存云端记录时才会请求后端。网页文件与访问流量仍按 Netlify 规则计入用量，因此适合个人或低流量使用。

1. 解压 ZIP，在 GitHub 新建仓库，把 ZIP 内部的项目内容直接上传到仓库根目录；不要把 `gomoku-account-site` 外层目录再套一层。确认仓库根目录能直接看到 `netlify.toml`、`package.json`、`public/`、`netlify/`。
2. 登录 Netlify，进入 **Add new project → Import an existing project**，选 GitHub、授权并选择刚才的仓库。Base directory 选仓库根目录。保留项目内 `netlify.toml` 的发布设置（Publish directory 为 `public`，Functions directory 为 `netlify/functions`）；Build command 留空。
3. 创建项目后，进入 **Project configuration → Environment variables**，添加以下变量并确保用于 **Production**：
   - `SESSION_SECRET`：至少 32 个随机字符；可在本机 Node.js 中生成：

     ```sh
     node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
     ```

   - `ACCOUNT_GATE_PASSWORD`：设为部署者指定的授权码。只在 Netlify 环境变量里设置，不要提交到公开仓库或网页代码。
4. 保存变量后，进入 **Deploys → Trigger deploy → Deploy site** 重新发布，使函数读取新变量。Git 关联部署会构建 Functions 并安装项目依赖；账号和棋谱使用 Netlify Blobs，无需另建数据库。
5. 等 Production deploy 成功后，若站点是 Private，进入 **Project configuration → General → Visitor access → Project visibility**，将 Production 设为 **Public** 并保存。只有成功发布后才能切换公开；随后即可通过 Netlify 提供的 `*.netlify.app` 公共网址访问。
6. 用要保存本机棋谱的浏览器在线打开网址一次，等待页面载入完成，让浏览器安装离线缓存。以后若断网或站点暂时不可用，该浏览器可以打开缓存页面查看本机棋谱。

建议使用 Git 仓库导入，这样之后每次推送更新都会自动重新部署。Netlify 也支持已登录用户拖放项目，但手动部署更容易漏掉 Functions 配置；首次部署按上面的仓库导入步骤操作最稳妥。

本机开发可安装 Node.js 22.12 或更新版本后运行 `npm install`、`npx netlify login`、`npx netlify link`，然后用 `npm run dev` 预览；`npm run deploy` 发布正式站点。

## 访客模式与云端账号

- 初次打开不请求 `/api/me`，也不访问 Functions 或 Blobs。访客可以直接选择难度、落子、重新开始、悔棋、查看历史和复盘。
- 每局结束时棋谱先写到当前浏览器的 `localStorage`；登录状态下再写入云端。两边使用同一局标识合并显示，避免重复；即使云端暂时无法访问，本机副本仍可查看。
- 访客棋谱只存到当前浏览器的 `localStorage`。换浏览器或清除该站点数据后，本机记录不会跟随。
- 登录棋谱保存在当前浏览器的账号专属本机副本中。浏览器会记住最近登录过的账号名，以便断网或站点停运时打开缓存页面后，仍能看到该账号在本机的备份；此本机标记不代表当前已登录云端。网站首次在线打开后会缓存游戏页面；清除浏览器站点数据也会清除本机副本和页面缓存。
- 顶部红色「点击登录」打开授权码窗口；通过服务端验证后，才能注册或登录账号。授权码只设置在 Netlify 环境变量，不放在公开 HTML 中。
- 登录后按钮变为绿色「已登录」。结束的对局会同时写入本机与该账号云端；更换设备后，通过相同授权码及账号密码登录即可查看云端历史和复盘。
- 账号不要求手机号、邮箱或第三方绑定。账号最多 256 UTF-8 字节，密码最多 1024 UTF-8 字节；密码用 scrypt 加盐哈希保存。云端登录状态通过 HttpOnly 签名 Cookie 维持。

## 棋力与规则

- 使用 15×15 自由规则续局：黑白双方连成五子或更多即胜，不启用连珠禁手。Swap2 开局流程参照 RIF 规则：玩家在任意空位依次摆黑、白、黑；电脑选择执黑/执白，或补下白、黑两子后让玩家选颜色。直接选色时由白棋下第 4 子；若补两子，选色后由白棋下第 6 子。本项目保留自由规则的连五或以上胜负判定，不等同于 RIF 比赛的完整胜负规则。
- 四档 AI 在登录与访客模式下完全相同，均在浏览器本地计算，不调用云端 AI 服务。入门/进阶使用轻量策略；高手约思考 1.5 秒，顶级约 6 秒。
- 高手和顶级使用独立 Web Worker 引擎，包含增量棋型评估、PVS/α-β 迭代加深、置换表、必胜/必防检测、强制手延伸、威胁静态搜索和 VCF 连续冲四搜索。搜索有时间、节点和候选点限制，结果是启发式判断。
- Swap2 选择使用有限搜索的黑方评估；默认 ±10,000 分作为平衡带，近似均衡时补两子。评估偏黑时电脑经常选黑是搜索结果，不是固定写死的选项；分数不是胜率或必胜证明。
- DSH 提供的模式测试、状态机测试和定时对弈测试有助于比较引擎；我们独立复跑的 10 局等时对弈为新引擎 9 胜、旧引擎 1 胜。样本数量有限，不能推导对所有对手或所有规则都占优。
- 有限的浏览器搜索不能保证绝对无敌；VCF 没有找到强制线也不代表证明不存在。
## 项目结构

```text
public/index.html          游戏、访客历史、Swap2 流程与界面
public/gomoku-ai.js        高手/顶级本地搜索引擎
public/device-archive.js   用户授权的同设备共享棋谱文件夹
public/service-worker.js   更新页面与引擎缓存，保留离线查看入口
netlify/functions/api.mjs  授权、注册、登录、会话和云端棋谱接口
netlify.toml               Netlify 发布、函数路由与安全响应头
package.json               Netlify Blobs 与 CLI 依赖
```



## 同一设备跨浏览器查看本机棋谱

在历史对局抽屉的“设备共享存档”区域，支持文件夹访问的浏览器可点击“选择共享文件夹”，并在同一设备的各浏览器中选择同一个电脑或手机文件夹。首次连接时各浏览器分别授权一次；之后对局结束时会自动保存到共享文件夹，打开历史对局时会自动同步其他浏览器的棋谱。棋谱以小型 JSON 文件保存在所选设备文件夹，不上传到 Netlify。若浏览器不支持共享文件夹，可用“导出备份”和“导入备份”转移 JSON 文件。网页只访问用户明确选择的目录，不申请整台设备的存储权限。文件夹访问能力因浏览器和手机系统而异。
