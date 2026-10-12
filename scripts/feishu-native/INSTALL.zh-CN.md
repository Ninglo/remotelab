# 飞书增强版：一条命令试装

适用于 **M 系列 Mac、飞书 8.1.17**。打开“终端”，粘贴运行：

```bash
curl -fL --retry 5 --retry-all-errors --connect-timeout 15 --max-time 120 https://index.jiujianian.dev/public-pages/feishu-native-install/install.sh -o /tmp/feishu-native-install.sh && /bin/bash /tmp/feishu-native-install.sh
```

命令会检查飞书版本，自动准备所需文件，安装并打开独立增强版。无需手动装 Node、Python、Homebrew 或 Xcode，也无需管理员密码。首次下载约 80 MB，按小片段校验保存；网络失败后重跑会复用完整文件和已完成片段，不再整包从头下载。入口会自动重试网络错误，完整下载后才执行。GitHub 不是必需主下载源。完成后在新窗口登录**你本人的飞书账号**。之后可从个人“应用程序”目录打开“飞书增强版”。

正式飞书和原登录数据保留。重复运行同一命令会保留本次试装的账号、草稿和设置；遇到不同版本或未完成的旧安装会停止并保留现场，反馈终端提示即可，不要删除原飞书或为试装降级。旧脚本失败时已删除的半包无法恢复，但此前完整下载的 Node 文件仍可直接复用。

## 试用范围与更新

主题、字体、设置和四个侧栏入口可试。个人 Index、thinking、消息设置需要本人连接 RemoteLab 后验证。群看板、Session 状态、用量和消息成果需要这台 Mac 的状态来源；安装命令不会复制其他机器的账号或连接，也不会自动接通这些数据。8.1.17 登录后的完整功能、语音输入和会议媒体尚未验收。

本入口简化安装，**暂不支持增强代码热更新**。重复执行当前命令只校验并打开同一版本，不会强制重启正在使用的增强版。飞书官方升级、增强代码更新和群状态的实时同步是不同功能。

## 停用与问题反馈

退出“飞书原生增强试验”，继续使用原飞书即可。出现错误时，把终端最后一条错误发回原话题；账号、草稿、设置和运行文件留在本机，不必发送整个目录。

维护者核验入口：`bash install.sh --check` 只核对版本与资源。`--source /path/to/Lark.app` 可指定已安装飞书的位置；`--test-home /private/test/directory` 用于隔离验证且不打开应用。安装文件存放在个人 `Library/Application Support/RemoteLab` 下，个人账号数据在独立 `Library/Application Support/RlfeTrial` 下。
