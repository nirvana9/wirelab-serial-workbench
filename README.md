# WireLab 串口调试工作台

中文版浏览器工具，用于连接 USB 串口、收发指令和分析设备日志。

## 功能

- Web Serial 实际连接、收发和断开串口；可设置波特率、数据位、停止位、校验和流控。
- UTF-8 / HEX 指令，CR / LF / CRLF 行尾，SUM8 / XOR8 / CRC16 MODBUS 校验。
- 浏览器本地指令库、实时终端、文字 / HEX 显示、搜索、暂停和导出。
- 导入或粘贴日志，按规则标记错误和警告，查看上下文并导出。
- 可识别的示例模式，方便在未连接设备时查看功能。

## 使用

通过 HTTPS 打开网站，使用支持 Web Serial 的电脑端浏览器（推荐 Chrome）。设置与设备一致的串口参数，然后点击连接并在浏览器弹窗中选择设备。USB 转串口需要适用驱动，串口不能被其他软件占用。

日志和指令只在本地处理，不上传到服务器；指令库和配置存储于当前网站的 localStorage，日志保存在内存中。不同网站地址拥有独立的本地存储，迁移网站后可通过导出 / 导入转移指令库。

终端保留最近 10000 条收发记录，一次最多显示 1000 条；导入日志限制 10 MiB。规则分析用于提供排查线索。

## 本地运行与验证

无需安装 npm 依赖。建议使用 Node.js 24：

```sh
npm run check
npm test
python3 -m http.server 8080 --directory dist
```

打开 `http://localhost:8080`。Web Serial 可在 localhost 安全上下文中使用。

自动测试覆盖字节解析、校验、日志、UTF-8 分块与串口生命周期。实际 USB 串口和浏览器权限需要使用真实设备验证。

## 腾讯云 EdgeOne 发布

网站文件位于 `dist/`，使用相对资源路径。源码托管于 GitHub，网站通过 EdgeOne Pages（现 EdgeOne Makers）发布。

1. 在 EdgeOne 控制台选择导入 Git 仓库，连接 GitHub，选择本仓库。
2. 生产分支选择 `main`，框架选择 Other，项目根目录使用仓库根目录。
3. 构建命令填写 `npm run check && npm test`，输出目录填写 `dist`。
4. 点击部署，使用控制台给出的 HTTPS 地址访问网站。

后续提交到 `main` 会由 EdgeOne 自动拉取并部署。GitHub Actions 也会执行语法检查和测试。

参考：[EdgeOne 导入 Git 仓库官方文档](https://pages.edgeone.ai/zh/document/importing-a-git-repository)。
