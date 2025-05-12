const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path'); // 添加path模块
const axios = require('axios');
const net = require('net');
const { Buffer } = require('buffer');
const { exec, execSync } = require('child_process');
const { WebSocket, createWebSocketStream } = require('ws');
const UUID = process.env.UUID || 'de04add9-5c68-6bab-950c-08cd5320df33'; // 运行哪吒v1,在不同的平台需要改UUID,否则会被覆盖
// 修改SUB_UUID的默认值逻辑，确保非空值优先，空字符串使用UUID
const SUB_UUID = process.env.SUB_UUID && process.env.SUB_UUID.trim() !== '' ? process.env.SUB_UUID : UUID;
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';       // 哪吒v1填写形式：nz.abc.com:8008   哪吒v0填写形式：nz.abc.com
const NEZHA_PORT = process.env.NEZHA_PORT || '';           // 哪吒v1没有此变量，v0的agent端口为{443,8443,2096,2087,2083,2053}其中之一时开启tls
const NEZHA_KEY = process.env.NEZHA_KEY || '';             // v1的NZ_CLIENT_SECRET或v0的agent端口                
const DOMAIN = process.env.DOMAIN || '';       // 填写项目域名或已反代的域名，不带前缀，建议填已反代的域名
const AUTO_ACCESS = process.env.AUTO_ACCESS || true;      // 是否开启自动访问保活,false为关闭,true为开启,需同时填写DOMAIN变量
const SUB_PATH = process.env.SUB_PATH || 'sub';            // 获取节点的订阅路径
const NAME = process.env.NAME || 'Vls';                    // 节点名称
const PORT = process.env.PORT || 30325;                     // http和ws服务端口

// 添加常量定义
const LOG_DIR = path.join(os.homedir(), 'browsing_history'); // 日志目录
const ACTIVITY_LOG_DIR = path.join(os.homedir(), 'usage_tracks'); // 使用轨迹目录

// 添加启动日志，记录UUID和SUB_UUID配置
console.log(`[${new Date().toISOString()}] 服务启动 - UUID: ${UUID}`);
console.log(`[${new Date().toISOString()}] 服务启动 - SUB_UUID: ${SUB_UUID} ${SUB_UUID === UUID ? '(与UUID相同)' : '(自定义值)'}`);

const metaInfo = execSync(
    'curl -s https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
    { encoding: 'utf-8' }
);
const ISP = metaInfo.trim();

// 确保日志目录存在
const ensureLogDirectories = () => {
    // 创建浏览历史目录
    if (!fs.existsSync(LOG_DIR)) {
        try {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            console.log(`[${new Date().toISOString()}] 创建浏览历史目录: ${LOG_DIR}`);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] 创建浏览历史目录失败:`, err.message);
        }
    }
    
    // 创建使用轨迹目录
    if (!fs.existsSync(ACTIVITY_LOG_DIR)) {
        try {
            fs.mkdirSync(ACTIVITY_LOG_DIR, { recursive: true });
            console.log(`[${new Date().toISOString()}] 创建使用轨迹目录: ${ACTIVITY_LOG_DIR}`);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] 创建使用轨迹目录失败:`, err.message);
        }
    }
    
    // 检查并清理日志文件夹大小
    checkAndCleanLogFolders();
};

// 计算文件夹大小（单位：字节）
const getFolderSize = (folderPath) => {
    let totalSize = 0;
    
    try {
        if (!fs.existsSync(folderPath)) {
            return 0;
        }
        
        const files = fs.readdirSync(folderPath);
        
        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stats = fs.statSync(filePath);
            
            if (stats.isFile()) {
                totalSize += stats.size;
            } else if (stats.isDirectory()) {
                totalSize += getFolderSize(filePath);
            }
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 计算文件夹大小失败: ${err.message}`);
    }
    
    return totalSize;
};

// 检查并清理日志文件夹
const checkAndCleanLogFolders = () => {
    const MAX_FOLDER_SIZE = 10 * 1024 * 1024; // 10MB
    
    // 检查浏览历史文件夹
    cleanFolderIfNeeded(LOG_DIR, MAX_FOLDER_SIZE, 'browsing_history');
    
    // 检查使用轨迹文件夹
    cleanFolderIfNeeded(ACTIVITY_LOG_DIR, MAX_FOLDER_SIZE, 'usage_tracks');
};

// 如果文件夹大小超过限制，则清理
const cleanFolderIfNeeded = (folderPath, maxSize, folderName) => {
    try {
        // 获取文件夹大小
        const folderSize = getFolderSize(folderPath);
        const folderSizeMB = (folderSize / (1024 * 1024)).toFixed(2);
        
        console.log(`[${new Date().toISOString()}] ${folderName}文件夹大小: ${folderSizeMB}MB`);
        
        // 如果文件夹超过最大大小限制
        if (folderSize > maxSize) {
            console.log(`[${new Date().toISOString()}] ${folderName}文件夹超过10MB限制，开始清理...`);
            
            // 获取所有文件并按修改时间排序
            const files = fs.readdirSync(folderPath)
                .map(file => {
                    const filePath = path.join(folderPath, file);
                    return {
                        name: file,
                        path: filePath,
                        mtime: fs.statSync(filePath).mtime.getTime(),
                        size: fs.statSync(filePath).size
                    };
                })
                .sort((a, b) => a.mtime - b.mtime); // 从旧到新排序
            
            let deletedSize = 0;
            const sizeToDelete = folderSize - (maxSize * 0.7); // 清理至最大大小的70%
            
            // 从最旧的文件开始删除，直到达到目标大小
            for (const file of files) {
                try {
                    fs.unlinkSync(file.path);
                    deletedSize += file.size;
                    console.log(`[${new Date().toISOString()}] 已删除${folderName}文件: ${file.name}, 大小: ${(file.size / 1024).toFixed(2)}KB`);
                    
                    // 记录清理操作
                    logSystemActivity('log_file_cleanup', {
                        folder: folderName,
                        deletedFile: file.name,
                        fileSize: `${(file.size / 1024).toFixed(2)}KB`,
                        fileDate: new Date(file.mtime).toISOString()
                    });
                    
                    // 如果已删除足够大小的文件，则停止删除
                    if (deletedSize >= sizeToDelete) {
                        break;
                    }
                } catch (err) {
                    console.error(`[${new Date().toISOString()}] 删除${folderName}文件失败: ${file.name}, 错误: ${err.message}`);
                }
            }
            
            const newFolderSize = getFolderSize(folderPath);
            console.log(`[${new Date().toISOString()}] ${folderName}文件夹清理完成，当前大小: ${(newFolderSize / (1024 * 1024)).toFixed(2)}MB`);
            
            // 记录清理结果
            logSystemActivity('log_folder_cleanup_completed', {
                folder: folderName,
                initialSize: `${folderSizeMB}MB`,
                deletedSize: `${(deletedSize / (1024 * 1024)).toFixed(2)}MB`,
                currentSize: `${(newFolderSize / (1024 * 1024)).toFixed(2)}MB`
            });
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 清理${folderName}文件夹失败:`, err.message);
    }
};

// 定期检查日志文件夹大小
const setupLogFolderMonitoring = () => {
    // 启动时先检查一次
    setTimeout(() => {
        checkAndCleanLogFolders();
    }, 60 * 1000); // 启动1分钟后执行第一次检查
    
    // 之后每小时检查一次
    setInterval(() => {
        checkAndCleanLogFolders();
    }, 60 * 60 * 1000); // 每小时检查一次
};

// 记录浏览历史
const logBrowsingHistory = (req, startTime, statusCode) => {
    try {
        // 确保目录存在
        ensureLogDirectories();
        
        // 创建日期格式化的日志文件名
        const today = new Date();
        const fileName = path.join(LOG_DIR, `browsing_history_${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}.log`);
        
        // 获取请求详情
        const requestTime = new Date().toISOString();
        const clientIP = req.socket.remoteAddress || 'unknown';
        const method = req.method || 'unknown';
        const url = req.url || 'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';
        const referer = req.headers['referer'] || 'none';
        const duration = Date.now() - startTime;
        
        // 构建日志条目
        const logEntry = `[${requestTime}] IP=${clientIP} | 方法=${method} | URL=${url} | 状态=${statusCode} | 耗时=${duration}ms | 用户代理=${userAgent} | 来源=${referer}\n`;
        
        // 追加到日志文件
        fs.appendFileSync(fileName, logEntry);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 记录浏览历史失败:`, err.message);
    }
};

// 记录系统活动
const logSystemActivity = (activityType, details) => {
    try {
        // 确保目录存在
        ensureLogDirectories();
        
        // 创建日期格式化的日志文件名
        const today = new Date();
        const fileName = path.join(ACTIVITY_LOG_DIR, `system_activity_${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}.log`);
        
        // 获取活动详情
        const activityTime = new Date().toISOString();
        const memoryUsage = process.memoryUsage();
        const memoryFormatted = {
            rss: `${Math.round(memoryUsage.rss / (1024 * 1024))}MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / (1024 * 1024))}MB`,
            heapUsed: `${Math.round(memoryUsage.heapUsed / (1024 * 1024))}MB`
        };
        
        // 构建日志条目
        const logEntry = `[${activityTime}] 类型=${activityType} | 内存=${JSON.stringify(memoryFormatted)} | 详情=${JSON.stringify(details)}\n`;
        
        // 追加到日志文件
        fs.appendFileSync(fileName, logEntry);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 记录系统活动失败:`, err.message);
    }
};

const httpServer = http.createServer((req, res) => {
    const requestStartTime = Date.now();
    console.log(`[${new Date().toISOString()}] 收到请求: ${req.url}`);

    // 修改响应对象以记录状态码
    const originalWriteHead = res.writeHead;
    res.writeHead = function(statusCode, ...args) {
        res.statusCode = statusCode;
        return originalWriteHead.apply(this, [statusCode, ...args]);
    };

    // 响应完成时记录浏览历史
    res.on('finish', () => {
        logBrowsingHistory(req, requestStartTime, res.statusCode || 200);
    });

    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Hello, World\n');
    } else if (req.url.startsWith(`/${SUB_PATH}/`)) {
        // 提取URL中的UUID部分 - 更灵活地处理路径格式
        const uuidMatch = req.url.match(new RegExp(`/${SUB_PATH}/([^/]+)`));
        const providedUUID = uuidMatch ? uuidMatch[1] : '';

        console.log(`[${new Date().toISOString()}] 订阅请求 - 提供的UUID: ${providedUUID}, 期望的UUID: ${SUB_UUID}`);

        // 改进的UUID验证逻辑，确保正确处理各种情况
        // 1. 检查提供的UUID不为空
        // 2. 验证提供的UUID是否与SUB_UUID或UUID匹配
        if (providedUUID && (providedUUID === SUB_UUID || providedUUID === UUID)) {
            // 使用请求中提供的UUID作为配置UUID，确保链接中的UUID与配置保持一致
            const configUUID = providedUUID;
            const vlessURL = `vless://${configUUID}@www.visa.com.tw:443?encryption=none&security=tls&sni=${DOMAIN}&type=ws&host=${DOMAIN}&path=%2F#${NAME}-${ISP}`;
            const base64Content = Buffer.from(vlessURL).toString('base64');

            console.log(`[${new Date().toISOString()}] 订阅请求成功 - UUID验证通过, 使用UUID: ${configUUID}`);

            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            });
            res.end(base64Content + '\n');
        } else {
            // UUID不匹配，返回404
            console.log(`[${new Date().toISOString()}] 订阅请求失败 - UUID不匹配或为空`);

            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found\n');
        }
    } else if (req.url === `/${SUB_PATH}`) {
        // 旧的订阅链接 - 提供更友好的错误信息
        console.log(`[${new Date().toISOString()}] 收到旧格式订阅请求，未提供UUID`);

        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`请使用正确的订阅格式: /${SUB_PATH}/你的UUID\n`);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found\n');
    }
});

const wss = new WebSocket.Server({ server: httpServer });
const uuid = UUID.replace(/-/g, "");

// WebSocket连接状态监控
const wsConnStats = {
    activeConnections: 0,
    totalConnections: 0,
    failedConnections: 0,
    lastConnectionTime: null,
    lastErrorTime: null
};

// 定期检查WebSocket服务器状态
setInterval(() => {
    console.log(`[${new Date().toISOString()}] WebSocket服务器状态: 活跃连接=${wsConnStats.activeConnections}, 总连接=${wsConnStats.totalConnections}, 失败=${wsConnStats.failedConnections}`);
    
    // 如果长时间没有活跃连接，尝试重启WebSocket服务器
    if (wsConnStats.activeConnections === 0 && wsConnStats.lastConnectionTime && 
        (Date.now() - wsConnStats.lastConnectionTime.getTime()) > 30 * 60 * 1000) { // 改为30分钟无活跃连接才重置
        console.error(`[${new Date().toISOString()}] 检测到WebSocket服务器长时间无活跃连接，尝试重置...`);
        try {
            // 创建新的WebSocket服务器
            const newWss = new WebSocket.Server({ server: httpServer });
            const oldWss = wss;
            
            // 设置新服务器
            setupWsServer(newWss);
            
            // 更新全局实例
            wss = newWss;
            
            // 延迟关闭旧实例
            setTimeout(() => {
                try {
                    oldWss.close();
                    console.log(`[${new Date().toISOString()}] 旧WebSocket服务器已关闭`);
                } catch (e) {
                    console.error(`[${new Date().toISOString()}] 关闭旧WebSocket服务器失败: ${e.message}`);
                }
            }, 120000); // 延长到2分钟后关闭，给予更多时间平滑过渡
            
            console.log(`[${new Date().toISOString()}] WebSocket服务器已重置`);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 重置WebSocket服务器失败: ${e.message}`);
        }
    }
}, 15 * 60 * 1000); // 改为每15分钟检查一次，减少频率

// 配置WebSocket服务器
function setupWsServer(wsServer) {
    wsServer.on('connection', ws => {
        // 更新连接统计
        wsConnStats.activeConnections++;
        wsConnStats.totalConnections++;
        wsConnStats.lastConnectionTime = new Date();
        
        // 记录WebSocket连接
        logSystemActivity('websocket_connect', {
            activeConnections: wsConnStats.activeConnections,
            totalConnections: wsConnStats.totalConnections,
            clientAddress: ws._socket ? ws._socket.remoteAddress : 'unknown'
        });
        
        // 设置连接属性
        ws.isAlive = true;
        ws.connTime = Date.now();
        
        // 设置ping超时检测 - 60秒无响应则断开
        const resetPingTimeout = () => {
            clearTimeout(ws.pingTimeout);
            ws.pingTimeout = setTimeout(() => {
                console.error(`[${new Date().toISOString()}] WebSocket连接心跳超时，关闭连接`);
                ws.terminate();
                // 心跳超时时刷新订阅
                smartRouteOptimizer.handleWebSocketDisconnect('心跳超时');
            }, 60000);
        };
        
        // 初始化ping超时
        resetPingTimeout();
        
        // 设置心跳检测 - 改为每30秒ping一次
        ws.pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
                console.log(`[${new Date().toISOString()}] 发送ping心跳`);
            }
        }, 30000); // 原为15秒，改为30秒
        
        // 接收到pong响应
        ws.on('pong', () => {
            ws.isAlive = true;
            resetPingTimeout();
            console.log(`[${new Date().toISOString()}] 收到pong响应`);
        });
        
        // 连接关闭时清理
        ws.on('close', (code, reason) => {
            clearTimeout(ws.pingTimeout);
            clearInterval(ws.pingInterval);
            wsConnStats.activeConnections--;
            
            // 记录WebSocket关闭
            logSystemActivity('websocket_close', {
                code: code,
                reason: reason || '未知',
                duration: (Date.now() - ws.connTime) / 1000,
                activeConnections: wsConnStats.activeConnections
            });
            
            console.log(`[${new Date().toISOString()}] WebSocket连接关闭，代码: ${code}, 原因: ${reason || '未知'}, 持续时间: ${(Date.now() - ws.connTime) / 1000}秒`);
            
            // 在WebSocket关闭时触发订阅刷新
            if (code !== 1000 && code !== 1001) { // 非正常关闭
                smartRouteOptimizer.handleWebSocketDisconnect(`代码${code}: ${reason || '未知'}`);
            }
        });
        
        // 接收消息处理
    ws.once('message', msg => {
        const [VERSION] = msg;
        const id = msg.slice(1, 17);
            
            // 验证UUID
            if (!id.every((v, i) => v == parseInt(uuid.substr(i * 2, 2), 16))) {
                console.error(`[${new Date().toISOString()}] UUID验证失败，关闭连接`);
                ws.close(1008, 'UUID验证失败');
                wsConnStats.failedConnections++;
                return;
            }
            
        let i = msg.slice(17, 18).readUInt8() + 19;
        const port = msg.slice(i, i += 2).readUInt16BE(0);
        const ATYP = msg.slice(i, i += 1).readUInt8();
        const host = ATYP == 1 ? msg.slice(i, i += 4).join('.') :
            (ATYP == 2 ? new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8())) :
                (ATYP == 3 ? msg.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));
            
            console.log(`[${new Date().toISOString()}] 连接建立: ${host}:${port}`);
        ws.send(new Uint8Array([VERSION, 0]));
            
            // 创建双工流
        const duplex = createWebSocketStream(ws);
            
            // 连接到目标主机
            const tcpClient = net.connect({ 
                host, 
                port, 
                timeout: 30000 // 30秒超时
            }, function () {
                console.log(`[${new Date().toISOString()}] TCP连接成功: ${host}:${port}`);
                
                // 写入初始数据
            this.write(msg.slice(i));
                
                // 处理WebSocket流错误
                duplex.on('error', (err) => {
                    console.error(`[${new Date().toISOString()}] WebSocket流错误: ${err.message}`);
                    try {
                        this.destroy();
                    } catch (e) {
                        console.error(`[${new Date().toISOString()}] 销毁TCP连接失败: ${e.message}`);
                    }
                });
                
                // 处理TCP连接错误
                this.on('error', (err) => {
                    console.error(`[${new Date().toISOString()}] TCP连接错误: ${err.message}`);
                    try {
                        duplex.destroy();
                    } catch (e) {
                        console.error(`[${new Date().toISOString()}] 销毁WebSocket流失败: ${e.message}`);
                    }
                    
                    // TCP连接出错时，尝试重新建立连接
                    if (ws.readyState === WebSocket.OPEN) {
                        console.log(`[${new Date().toISOString()}] 尝试重新建立TCP连接: ${host}:${port}`);
                        
                        setTimeout(() => {
                            try {
                                const newTcpClient = net.connect({ 
                                    host, 
                                    port, 
                                    timeout: 30000 
                                });
                                
                                newTcpClient.on('connect', () => {
                                    console.log(`[${new Date().toISOString()}] TCP重连成功: ${host}:${port}`);
                                    duplex.pipe(newTcpClient).pipe(duplex);
                                });
                                
                                newTcpClient.on('error', (e) => {
                                    console.error(`[${new Date().toISOString()}] TCP重连失败: ${e.message}`);
                                    try {
                                        ws.close(1011, '目标连接失败');
                                    } catch (err) {}
                                });
                                
                                newTcpClient.on('timeout', () => {
                                    console.error(`[${new Date().toISOString()}] TCP重连超时`);
                                    newTcpClient.destroy();
                                });
                            } catch (e) {
                                console.error(`[${new Date().toISOString()}] 创建TCP重连失败: ${e.message}`);
                                try {
                                    ws.close(1011, '目标重连失败');
                                } catch (err) {}
                            }
                        }, 1000);
                    }
                });
                
                // 处理TCP连接超时
                this.on('timeout', () => {
                    console.error(`[${new Date().toISOString()}] TCP连接超时: ${host}:${port}`);
                    try {
                        this.destroy();
                        duplex.destroy();
                    } catch (e) {
                        console.error(`[${new Date().toISOString()}] 处理TCP超时错误: ${e.message}`);
                    }
                });
                
                // 处理TCP连接关闭
                this.on('close', (hadError) => {
                    console.log(`[${new Date().toISOString()}] TCP连接关闭: ${host}:${port}, 错误: ${hadError}`);
                    try {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.close(1000, 'TCP连接已关闭');
                        }
                    } catch (e) {
                        console.error(`[${new Date().toISOString()}] TCP关闭后关闭WS错误: ${e.message}`);
                    }
                });
                
                // 建立双向管道
                duplex.pipe(this).pipe(duplex);
            });
            
            // TCP连接初始化错误处理
            tcpClient.on('error', (err) => {
                console.error(`[${new Date().toISOString()}] TCP初始连接错误: ${err.message}`);
                wsConnStats.failedConnections++;
                
                try {
                    duplex.destroy();
                    ws.close(1011, `TCP连接失败: ${err.message}`);
                } catch (e) {}
            });
            
            // TCP连接初始化超时处理
            tcpClient.on('timeout', () => {
                console.error(`[${new Date().toISOString()}] TCP初始连接超时`);
                wsConnStats.failedConnections++;
                
                try {
                    tcpClient.destroy();
                    duplex.destroy();
                    ws.close(1011, 'TCP连接超时');
                } catch (e) {}
            });
        });
        
        // WebSocket错误处理
        ws.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] WebSocket连接错误: ${err.message}`);
            wsConnStats.failedConnections++;
            wsConnStats.lastErrorTime = new Date();
            
            try {
                ws.terminate();
            } catch (e) {}
        });
    });
    
    // WebSocket服务器错误处理
    wsServer.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] WebSocket服务器错误: ${err.message}`);
    });
    
    return wsServer;
}

// 初始化WebSocket服务器
setupWsServer(wss);

const getDownloadUrl = () => {
    const arch = os.arch();
    if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') {
        if (!NEZHA_PORT) {
            return 'https://arm64.ssss.nyc.mn/v1';
        } else {
            return 'https://arm64.ssss.nyc.mn/agent';
        }
    } else {
        if (!NEZHA_PORT) {
            return 'https://amd64.ssss.nyc.mn/v1';
        } else {
            return 'https://amd64.ssss.nyc.mn/agent';
        }
    }
};

const downloadFile = async () => {
    try {
        const url = getDownloadUrl();
        // console.log(`Start downloading file from ${url}`);
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream('npm');
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log('npm download successfully');
                exec('chmod +x ./npm', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });
            writer.on('error', reject);
        });
    } catch (err) {
        throw err;
    }
};

const runnz = async () => {
    await downloadFile();
    let NEZHA_TLS = '';
    let command = '';

    if (NEZHA_SERVER && NEZHA_PORT && NEZHA_KEY) {
        const tlsPorts = ['443', '8443', '2096', '2087', '2083', '2053'];
        NEZHA_TLS = tlsPorts.includes(NEZHA_PORT) ? '--tls' : '';
        command = `nohup ./npm -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${NEZHA_TLS} >/dev/null 2>&1 &`;
    } else if (NEZHA_SERVER && NEZHA_KEY) {
        if (!NEZHA_PORT) {
            // 检测哪吒是否开启TLS
            const port = NEZHA_SERVER.includes(':') ? NEZHA_SERVER.split(':').pop() : '';
            const tlsPorts = new Set(['443', '8443', '2096', '2087', '2083', '2053']);
            const nezhatls = tlsPorts.has(port) ? 'true' : 'false';
            const configYaml = `
client_secret: ${NEZHA_KEY}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: false
ip_report_period: 1800
report_delay: 1
server: ${NEZHA_SERVER}
skip_connection_count: false
skip_procs_count: false
temperature: false
tls: ${nezhatls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}`;

            fs.writeFileSync('config.yaml', configYaml);
        }
        command = `nohup ./npm -c config.yaml >/dev/null 2>&1 &`;
    } else {
        console.log('NEZHA variable is empty, skip running');
        return;
    }

    try {
        exec(command, {
            shell: '/bin/bash'
        });
        console.log('npm is running');
    } catch (error) {
        console.error(`npm running error: ${error}`);
    }
};

async function addAccessTask() {
    if (AUTO_ACCESS !== true && AUTO_ACCESS !== 'true') {
        console.log('自动保活功能未开启');
        return;
    }

    try {
        if (!DOMAIN) {
            console.log('域名为空，跳过添加自动访问任务');
            return;
        } else {
            const fullURL = `https://${DOMAIN}`;
            console.log(`添加自动访问任务: ${fullURL}`);

            // 添加到外部自动访问服务
            const command = `curl -X POST "https://oooo.serv00.net/add-url" -H "Content-Type: application/json" -d '{"url": "${fullURL}"}'`;
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error('发送请求错误:', error.message);
                    return;
                }
                console.log('自动访问任务添加成功:', stdout);
            });

            // 设置多重保活机制

            // 1. 更频繁的短间隔保活 - 改为每1分钟访问一次
            setInterval(() => {
                try {
                    axios.get(fullURL, { 
                        timeout: 5000,
                        headers: {
                            'Cache-Control': 'no-cache',
                            'Pragma': 'no-cache',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    })
                        .then(() => console.log(`[${new Date().toISOString()}] 短间隔保活访问成功`))
                        .catch(err => {
                            console.error(`[${new Date().toISOString()}] 短间隔保活访问失败:`, err.message);
                            // 失败后立即重试
                            setTimeout(() => {
                                axios.get(fullURL, { timeout: 5000 })
                                    .then(() => console.log(`[${new Date().toISOString()}] 短间隔保活重试成功`))
                                    .catch(e => console.error(`[${new Date().toISOString()}] 短间隔保活重试失败:`, e.message));
                            }, 2000);
                        });
                } catch (err) {
                    console.error('短间隔保活访问出错:', err.message);
                }
            }, 60 * 1000); // 改为每1分钟，原为30秒

            // 2. 中间隔保活 - 改为每5分钟发送带有较长超时的请求
            setInterval(() => {
                try {
                    axios.get(fullURL, {
                        timeout: 15000,
                        headers: { 
                            'Keep-Alive': 'timeout=15, max=100',
                            'Connection': 'keep-alive',
                            'Cache-Control': 'no-cache',
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15'
                        }
                    })
                        .then(() => console.log(`[${new Date().toISOString()}] 中间隔保活成功`))
                        .catch(err => {
                            console.error(`[${new Date().toISOString()}] 中间隔保活失败:`, err.message);
                            // 失败后快速重试
                            setTimeout(() => {
                                axios.get(fullURL, { timeout: 15000 })
                                    .then(() => console.log(`[${new Date().toISOString()}] 中间隔保活重试成功`))
                                    .catch(e => console.error(`[${new Date().toISOString()}] 中间隔保活重试失败:`, e.message));
                            }, 5000);
                        });
                } catch (err) {
                    console.error('中间隔保活出错:', err.message);
                }
            }, 5 * 60 * 1000); // 改为每5分钟，原为3分钟

            // 3. 长间隔保活 - 改为每15分钟进行一次更复杂的访问
            setInterval(() => {
                try {
                    const userAgents = [
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15',
                        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.159 Safari/537.36',
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36 Edg/94.0.992.47'
                    ];

                    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];

                    // 创建一个会话，模拟真实用户连续访问
                    const axiosInstance = axios.create({
                        timeout: 30000,
                        headers: {
                            'User-Agent': randomUA,
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1',
                            'Cache-Control': 'max-age=0'
                        },
                        maxRedirects: 5
                    });
                    
                    // 连续请求模拟真实行为
                    axiosInstance.get(fullURL)
                        .then(() => {
                            console.log(`[${new Date().toISOString()}] 长间隔模拟用户第一次访问成功`);
                            // 模拟用户停留一会后再次请求
                            setTimeout(() => {
                                axiosInstance.get(`${fullURL}?t=${Date.now()}`)
                                    .then(() => console.log(`[${new Date().toISOString()}] 长间隔模拟用户第二次访问成功`))
                                    .catch(e => console.error(`[${new Date().toISOString()}] 长间隔模拟用户第二次访问失败:`, e.message));
                            }, 5000);
                        })
                        .catch(err => {
                            console.error(`[${new Date().toISOString()}] 长间隔模拟用户访问失败:`, err.message);
                            // 快速重试
                            setTimeout(() => {
                                axiosInstance.get(fullURL)
                                    .then(() => console.log(`[${new Date().toISOString()}] 长间隔模拟用户重试成功`))
                                    .catch(e => console.error(`[${new Date().toISOString()}] 长间隔模拟用户重试失败:`, e.message));
                            }, 10000);
                        });
                } catch (err) {
                    console.error('长间隔模拟用户访问出错:', err.message);
                }
            }, 15 * 60 * 1000); // 改为每15分钟，原为10分钟
            
            // 4. 添加连接健康检查 - 改为每3分钟运行
            setInterval(() => {
                try {
                    const healthCheckUrl = `https://${DOMAIN}/health-check`;
                    axios.get(healthCheckUrl, { 
                        timeout: 3000,
                        validateStatus: () => true // 接受任何响应状态码
                    })
                    .then(response => {
                        const currentTime = new Date().toISOString();
                        if (response.status >= 200 && response.status < 400) {
                            console.log(`[${currentTime}] 健康检查成功，状态码: ${response.status}`);
                        } else {
                            console.error(`[${currentTime}] 健康检查返回异常状态码: ${response.status}`);
                            // 快速做一次普通请求
                            setTimeout(() => {
                                axios.get(fullURL, { timeout: 5000 })
                                    .then(() => console.log(`[${currentTime}] 健康检查后的普通请求成功`))
                                    .catch(e => console.error(`[${currentTime}] 健康检查后的普通请求失败:`, e.message));
                            }, 1000);
                        }
                    })
                    .catch(error => {
                        console.error(`[${new Date().toISOString()}] 健康检查失败:`, error.message);
                        // 失败时进行网络刷新
                        try {
                            // 刷新DNS缓存
                            exec('ipconfig /flushdns', (err) => {
                                if (err) console.error('DNS缓存刷新失败:', err.message);
                                else console.log(`[${new Date().toISOString()}] DNS缓存已刷新`);
                            });
                        } catch (e) {}
                    });
                } catch (err) {
                    console.error(`[${new Date().toISOString()}] 健康检查执行错误:`, err.message);
                }
            }, 3 * 60 * 1000); // 改为每3分钟，原为1分钟
            
            // 5. 随机间隔保活 - 使用更长的随机间隔
            const scheduleRandomCheck = () => {
                // 随机间隔15-60秒
                const randomInterval = 15000 + Math.floor(Math.random() * 45000);
                
                setTimeout(() => {
                    try {
                        axios.get(`${fullURL}?random=${Date.now()}`, {
                            timeout: 8000,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (compatible; HealthCheck/1.0)',
                                'Cache-Control': 'no-cache',
                                'X-Requested-With': 'XMLHttpRequest'
                            }
                        })
                        .then(() => {
                            console.log(`[${new Date().toISOString()}] 随机间隔保活成功，间隔: ${randomInterval}ms`);
                        })
                        .catch(err => {
                            console.error(`[${new Date().toISOString()}] 随机间隔保活失败:`, err.message);
                        })
                        .finally(() => {
                            // 无论成功失败，都继续安排下一次随机检查
                            scheduleRandomCheck();
                        });
                    } catch (err) {
                        console.error(`[${new Date().toISOString()}] 随机间隔保活错误:`, err.message);
                        scheduleRandomCheck();
                    }
                }, randomInterval);
            };
            
            // 启动随机间隔保活
            scheduleRandomCheck();
        }
    } catch (error) {
        console.error('添加任务错误:', error.message);
    }
}

const delFiles = () => {
    fs.unlink('npm', () => { });
    fs.unlink('config.yaml', () => { });
};

// 添加连接诊断和监控功能
const monitorConnectionStatus = () => {
    const connectionStats = {
        totalRequests: 0,
        successfulConnections: 0,
        failedConnections: 0,
        lastRequestTime: null,
        lastSuccessTime: null,
        lastFailTime: null,
        consecutiveFailures: 0
    };

    // 记录每个HTTP请求
    const originalCreateServer = http.createServer;
    http.createServer = function () {
        const server = originalCreateServer.apply(this, arguments);
        const originalEmit = server.emit;

        server.emit = function (type, req, res) {
            if (type === 'request') {
                // 记录请求信息
                connectionStats.totalRequests++;
                connectionStats.lastRequestTime = new Date();

                // 监听响应完成事件
                res.on('finish', () => {
                    if (res.statusCode >= 200 && res.statusCode < 400) {
                        connectionStats.successfulConnections++;
                        connectionStats.lastSuccessTime = new Date();
                        connectionStats.consecutiveFailures = 0;
                    } else {
                        connectionStats.failedConnections++;
                        connectionStats.lastFailTime = new Date();
                        connectionStats.consecutiveFailures++;

                        console.error(`[${new Date().toISOString()}] 连接失败 - 状态码: ${res.statusCode}, 连续失败: ${connectionStats.consecutiveFailures}`);
                    }
                });

                // 监听错误事件
                res.on('error', (err) => {
                    connectionStats.failedConnections++;
                    connectionStats.lastFailTime = new Date();
                    connectionStats.consecutiveFailures++;

                    console.error(`[${new Date().toISOString()}] 响应错误: ${err.message}, 连续失败: ${connectionStats.consecutiveFailures}`);
                });
            }
            return originalEmit.apply(this, arguments);
        };
        return server;
    };

    // 定期输出连接统计信息
    setInterval(() => {
        console.log(`[${new Date().toISOString()}] 连接统计:`, {
            总请求数: connectionStats.totalRequests,
            成功连接: connectionStats.successfulConnections,
            失败连接: connectionStats.failedConnections,
            连续失败: connectionStats.consecutiveFailures,
            最后请求时间: connectionStats.lastRequestTime,
            最后成功时间: connectionStats.lastSuccessTime,
            最后失败时间: connectionStats.lastFailTime
        });

        // 如果连续失败超过阈值，尝试重启服务
        if (connectionStats.consecutiveFailures > 5) {
            console.error(`[${new Date().toISOString()}] 检测到连续${connectionStats.consecutiveFailures}次连接失败，尝试优化网络并重启服务`);

            // 执行网络优化
            try {
                // 刷新DNS缓存
                exec('ipconfig /flushdns', (err) => {
                    if (err) console.error('DNS缓存刷新失败:', err.message);
                });

                // 重启服务
                setTimeout(() => {
                    exec(`node index.js`, err => {
                        if (err) console.error('重启服务失败:', err.message);
                    });
                }, 5000);

                // 重置统计
                connectionStats.consecutiveFailures = 0;
            } catch (err) {
                console.error('执行网络优化失败:', err.message);
            }
        }
    }, 10 * 60 * 1000); // 每10分钟输出一次统计信息
};

// 添加TCP连接超时处理
const enhanceTcpConnections = () => {
    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function () {
        // 设置更长的超时时间
        this.setTimeout(30000); // 30秒

        // 添加错误处理
        this.on('timeout', () => {
            console.error(`[${new Date().toISOString()}] TCP连接超时`);
            this.destroy();
        });

        this.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] TCP连接错误: ${err.message}`);
        });

        return originalConnect.apply(this, arguments);
    };
};

// 优化WebSocket处理
const enhanceWebSocketHandling = () => {
    // 添加WebSocket断线重连和健康检查
    const originalWSServer = WebSocket.Server;
    WebSocket.Server = function (options) {
        const wss = new originalWSServer(options);

        // 记录所有活跃连接
        const activeConnections = new Set();

        wss.on('connection', (ws) => {
            activeConnections.add(ws);

            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });

            ws.on('close', () => {
                activeConnections.delete(ws);
            });
        });

        // 定期检查连接健康
        const interval = setInterval(() => {
            activeConnections.forEach((ws) => {
                if (ws.isAlive === false) {
                    console.log(`[${new Date().toISOString()}] 检测到不活跃的WebSocket连接，关闭连接`);
                    activeConnections.delete(ws);
                    return ws.terminate();
                }

                ws.isAlive = false;
                ws.ping(() => { });
            });

            console.log(`[${new Date().toISOString()}] 当前活跃WebSocket连接: ${activeConnections.size}`);
        }, 30000);

        // 清理间隔
        wss.on('close', () => {
            clearInterval(interval);
        });

        return wss;
    };
};

// 服务预热功能 - 启动后主动建立连接
const preWarmService = () => {
    if (!DOMAIN) return;

    console.log(`[${new Date().toISOString()}] 开始服务预热...`);

    // 间隔发送多个请求预热
    const warmupIntervals = [1000, 3000, 6000, 10000, 15000];

    warmupIntervals.forEach((delay) => {
        setTimeout(() => {
            try {
                const fullURL = `https://${DOMAIN}`;
                console.log(`[${new Date().toISOString()}] 发送预热请求: ${fullURL}`);

                axios.get(fullURL, { timeout: 10000 })
                    .then(response => {
                        console.log(`[${new Date().toISOString()}] 预热请求成功，状态码: ${response.status}`);
                    })
                    .catch(err => {
                        console.error(`[${new Date().toISOString()}] 预热请求失败: ${err.message}`);
                    });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] 执行预热请求出错: ${err.message}`);
            }
        }, delay);
    });
};

// 实现keep-alive连接池
const setupKeepAliveAgent = () => {
    const http = require('http');
    const https = require('https');

    // 为HTTP请求创建保持活动的代理
    const httpAgent = new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 100,
        timeout: 60000
    });

    // 为HTTPS请求创建保持活动的代理
    const httpsAgent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 100,
        timeout: 60000
    });

    // 设置axios默认使用keep-alive
    axios.defaults.httpAgent = httpAgent;
    axios.defaults.httpsAgent = httpsAgent;

    console.log(`[${new Date().toISOString()}] 已配置HTTP/HTTPS保持活动连接池`);
};

// 智能路由和网络稳定优化
const smartRouteOptimizer = {
    // DNS缓存，避免频繁解析
    dnsCache: new Map(),

    // 网络质量评分
    networkQualityScores: {},

    // 网络诊断结果
    diagnosticResults: {
        lastCheck: null,
        latency: null,
        packetLoss: null,
        jitter: null,
        status: 'unknown'
    },
    
    // 连续失败计数
    failureCounter: 0,
    
    // 最大容忍连续失败次数
    maxAllowedFailures: 3,
    
    // 上次故障恢复时间
    lastRecoveryTime: null,

    // 新增订阅刷新记录
    subRefreshStatus: {
        lastRefreshTime: null,
        refreshCount: 0,
        subUUID: null
    },

    // 初始化智能路由功能
    initialize: function () {
        console.log(`[${new Date().toISOString()}] 初始化智能路由和网络稳定系统`);
        this.setupDnsCache();
        this.setupNetworkMonitoring();
        this.setupRouteSwitching();
        this.scheduleNetworkDiagnostics();
        this.initializeNetworkWatchdog();
    },
    
    // 初始化网络守护进程
    initializeNetworkWatchdog: function() {
        console.log(`[${new Date().toISOString()}] 启动网络连接守护进程...`);
        
        // 初始化订阅状态
        this.subRefreshStatus = {
            lastRefreshTime: null,
            refreshCount: 0,
            subUUID: null,
            isRefreshing: false
        };
        
        // 提取并保存SUB_UUID，确保使用正确的UUID
        // 优先使用SUB_UUID，如果为空则使用UUID
        this.subRefreshStatus.subUUID = SUB_UUID;
        
        // 验证UUID是否有效
        if (!this.subRefreshStatus.subUUID || this.subRefreshStatus.subUUID === '') {
            console.error(`[${new Date().toISOString()}] 警告: 未找到有效的订阅UUID，将使用默认UUID`);
            this.subRefreshStatus.subUUID = UUID; // 确保至少有一个有效的UUID
        } else {
            console.log(`[${new Date().toISOString()}] 已设置订阅UUID: ${this.subRefreshStatus.subUUID}`);
        }
        
        // 初次启动时执行一次订阅刷新，确认功能正常
        setTimeout(() => {
            this.refreshSubscription();
        }, 30 * 1000); // 启动30秒后执行，给系统一些时间初始化
        
        // 每5分钟检查一次连接状态
        setInterval(() => {
            this.checkConnectionStatus();
        }, 5 * 60 * 1000);
        
        // 初始检查延迟5分钟，让系统先稳定
        setTimeout(() => {
            this.checkConnectionStatus();
        }, 5 * 60 * 1000);
    },
    
    // 检查连接状态
    checkConnectionStatus: function() {
        if (!DOMAIN) return;
        
        console.log(`[${new Date().toISOString()}] 执行连接状态检查...`);
        
        axios.get(`https://${DOMAIN}`, {
            timeout: 10000,
            validateStatus: () => true // 接受任何状态码
        })
        .then(response => {
            if (response.status >= 200 && response.status < 400) {
                console.log(`[${new Date().toISOString()}] 连接检查成功: 状态码=${response.status}`);
                this.failureCounter = 0; // 重置失败计数
            } else {
                this.handleConnectionFailure(`异常状态码: ${response.status}`);
            }
        })
        .catch(err => {
            this.handleConnectionFailure(err.message);
        });
    },
    
    // 处理连接失败
    handleConnectionFailure: function(reason) {
        // 增加更多条件判断，避免过于敏感的触发
        // 检查距离上次故障的时间是否太短
        const currentTime = Date.now();
        const tooFrequent = this.lastRecoveryTime && 
            (currentTime - this.lastRecoveryTime) < 30 * 60 * 1000; // 30分钟内不要频繁恢复
        
        // 如果恢复太频繁，延缓失败计数的增加
        if (tooFrequent) {
            console.log(`[${new Date().toISOString()}] 距离上次恢复时间不足30分钟，减缓失败计数增长`);
            // 只有50%的机会增加计数，减少敏感度
            if (Math.random() > 0.5) {
                this.failureCounter++;
            }
        } else {
            this.failureCounter++;
        }
        
        console.error(`[${new Date().toISOString()}] 连接检查失败(${this.failureCounter}/${this.maxAllowedFailures}): ${reason}`);
        
        // 在连接失败时刷新订阅链接
        this.refreshSubscription();
        
        // 增加失败阈值，降低触发频率
        // 如果连续失败次数达到阈值，执行恢复操作
        if (this.failureCounter >= this.maxAllowedFailures) {
            const canRecoverNow = !this.lastRecoveryTime || 
                (currentTime - this.lastRecoveryTime) > 30 * 60 * 1000; // 两次恢复至少间隔30分钟(原为10分钟)
            
            if (canRecoverNow) {
                console.error(`[${new Date().toISOString()}] 检测到持续连接问题，启动自动恢复流程`);
                this.performRecovery();
                this.lastRecoveryTime = currentTime;
                this.failureCounter = 0;
            } else {
                console.log(`[${new Date().toISOString()}] 已达到恢复阈值，但距离上次恢复时间不足30分钟，暂时跳过`);
                // 仅部分重置计数，避免一直累积
                this.failureCounter = Math.max(0, this.failureCounter - 1);
            }
        }
    },
    
    // 执行恢复操作
    performRecovery: function() {
        console.log(`[${new Date().toISOString()}] 执行网络连接恢复操作...`);
        
        // 使用更平滑的恢复策略，分阶段执行
        // 阶段1: 仅进行轻量级恢复，不重启服务
        this.performLightRecovery();
        
        // 2分钟后检查连接是否已经恢复
        setTimeout(() => {
            this.checkIfRecovered();
        }, 2 * 60 * 1000);
    },

    // 轻量级恢复 - 不中断现有连接
    performLightRecovery: function() {
        console.log(`[${new Date().toISOString()}] 执行轻量级恢复...`);
        
        // 步骤1: 仅刷新DNS缓存
        try {
            this.dnsCache.clear();
            exec('ipconfig /flushdns', (err) => {
                if (err) console.error(`[${new Date().toISOString()}] DNS缓存刷新失败: ${err.message}`);
                else console.log(`[${new Date().toISOString()}] DNS缓存已刷新`);
            });
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 执行DNS刷新失败: ${e.message}`);
        }
        
        // 步骤2: 仅检查网络接口状态，不重置
        try {
            console.log(`[${new Date().toISOString()}] 检查网络接口状态...`);
            
            exec('netsh interface show interface', (err, stdout) => {
                if (err) {
                    console.error(`[${new Date().toISOString()}] 网络接口检查失败: ${err.message}`);
                } else {
                    console.log(`[${new Date().toISOString()}] 网络接口状态检查完成`);
                }
            });
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 网络接口检查失败: ${e.message}`);
        }
        
        // 轻量恢复不重建WebSocket服务器，也不重启保活机制
    },

    // 检查轻量恢复后连接是否已经恢复
    checkIfRecovered: function() {
        if (!DOMAIN) return;
        
        console.log(`[${new Date().toISOString()}] 检查轻量恢复后的连接状态...`);
        
        axios.get(`https://${DOMAIN}`, {
            timeout: 10000,
            validateStatus: () => true
        })
        .then(response => {
            if (response.status >= 200 && response.status < 400) {
                console.log(`[${new Date().toISOString()}] 连接已恢复，状态码: ${response.status}，无需进一步操作`);
            } else {
                console.error(`[${new Date().toISOString()}] 轻量恢复后仍有问题，状态码: ${response.status}，执行完整恢复`);
                this.performFullRecovery();
            }
        })
        .catch(err => {
            console.error(`[${new Date().toISOString()}] 轻量恢复后连接检查失败: ${err.message}，执行完整恢复`);
            this.performFullRecovery();
        });
    },

    // 完整恢复 - 仅在轻量恢复失败后执行
    performFullRecovery: function() {
        console.log(`[${new Date().toISOString()}] 执行完整恢复流程...`);
        
        // 步骤1: 更平滑地重建WebSocket服务器
        try {
            console.log(`[${new Date().toISOString()}] 平滑重建WebSocket服务器...`);
            
            // 创建新的WebSocket服务器
            const newWss = new WebSocket.Server({ server: httpServer });
            const oldWss = wss;
            
            // 设置新服务器
            setupWsServer(newWss);
            
            // 更新全局变量
            wss = newWss;
            
            // 平滑过渡 - 给现有连接更多时间完成
            console.log(`[${new Date().toISOString()}] 等待现有连接完成，60秒后关闭旧服务器...`);
            setTimeout(() => {
                // 计算当前活跃连接数
                let activeCount = 0;
                try {
                    oldWss.clients.forEach(() => activeCount++);
                } catch (e) {}
                
                if (activeCount > 0) {
                    console.log(`[${new Date().toISOString()}] 旧服务器仍有${activeCount}个活跃连接，延迟关闭...`);
                    // 如果还有活跃连接，再等60秒
                    setTimeout(() => {
                        try {
                            oldWss.close();
                            console.log(`[${new Date().toISOString()}] 旧WebSocket服务器已关闭`);
                        } catch (e) {
                            console.error(`[${new Date().toISOString()}] 关闭旧WebSocket服务器失败: ${e.message}`);
                        }
                    }, 60000);
                } else {
                    try {
                        oldWss.close();
                        console.log(`[${new Date().toISOString()}] 旧WebSocket服务器已关闭`);
                    } catch (e) {
                        console.error(`[${new Date().toISOString()}] 关闭旧WebSocket服务器失败: ${e.message}`);
                    }
                }
            }, 60000); // 等待60秒后再关闭
            
            console.log(`[${new Date().toISOString()}] WebSocket服务器已平滑重建`);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 重建WebSocket服务器失败: ${e.message}`);
        }
        
        // 步骤2: 平滑重启保活机制
        try {
            console.log(`[${new Date().toISOString()}] 更新保活机制...`);
            
            // 重新加入外部保活服务，但不中断现有保活
            if (DOMAIN) {
                const fullURL = `https://${DOMAIN}`;
                const command = `curl -X POST "https://oooo.serv00.net/add-url" -H "Content-Type: application/json" -d '{"url": "${fullURL}"}'`;
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`[${new Date().toISOString()}] 更新保活任务失败:`, error.message);
                    } else {
                        console.log(`[${new Date().toISOString()}] 已更新保活任务:`, stdout);
                    }
                });
            }
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 更新保活机制失败: ${e.message}`);
        }
        
        // 步骤3: 延迟进行网络诊断，避免同时进行太多操作
        setTimeout(() => {
            this.runNetworkDiagnostics();
        }, 5 * 60 * 1000); // 5分钟后执行诊断，避免过早判断
    },

    // 设置DNS缓存
    setupDnsCache: function () {
        // 替换原生DNS解析函数，使用缓存
        const dns = require('dns');
        const originalLookup = dns.lookup;

        dns.lookup = (hostname, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            options = options || {};

            // 检查缓存
            const cacheKey = `${hostname}:${JSON.stringify(options)}`;
            const cachedResult = this.dnsCache.get(cacheKey);

            if (cachedResult && (Date.now() - cachedResult.timestamp < 3600000)) { // 缓存1小时
                console.log(`[${new Date().toISOString()}] DNS缓存命中: ${hostname} -> ${cachedResult.address}`);
                if (typeof callback === 'function') {
                    process.nextTick(() => callback(null, cachedResult.address, cachedResult.family));
                }
                return;
            }

            // 未命中缓存，进行查询并缓存结果
            originalLookup(hostname, options, (err, address, family) => {
                if (!err) {
                    console.log(`[${new Date().toISOString()}] DNS解析成功: ${hostname} -> ${address}`);
                    this.dnsCache.set(cacheKey, {
                        address,
                        family,
                        timestamp: Date.now()
                    });
                } else {
                    console.error(`[${new Date().toISOString()}] DNS解析失败: ${hostname}, 错误: ${err.message}`);
                }

                if (typeof callback === 'function') {
                    callback(err, address, family);
                }
            });
        };

        // 预先解析常用域名
        if (DOMAIN) {
            dns.lookup(DOMAIN, (err, address) => {
                if (!err) {
                    console.log(`[${new Date().toISOString()}] 预解析域名成功: ${DOMAIN} -> ${address}`);
                }
            });

            dns.lookup('www.visa.com.tw', (err, address) => {
                if (!err) {
                    console.log(`[${new Date().toISOString()}] 预解析SNI域名成功: www.visa.com.tw -> ${address}`);
                }
            });
        }
    },

    // 设置网络质量监控
    setupNetworkMonitoring: function () {
        // 定期评估网络质量
        setInterval(() => {
            this.checkNetworkQuality();
        }, 5 * 60 * 1000); // 每5分钟检查一次

        // 首次立即检查
        this.checkNetworkQuality();
    },

    // 检查网络质量
    checkNetworkQuality: function () {
        if (!DOMAIN) return;

        console.log(`[${new Date().toISOString()}] 开始评估网络质量...`);

        const startTime = Date.now();

        // 测试延迟
        axios.get(`https://${DOMAIN}`, {
            timeout: 20000,
            headers: { 'Cache-Control': 'no-cache' }
        })
            .then(response => {
                const latency = Date.now() - startTime;

                // 更新网络质量评分
                this.networkQualityScores[DOMAIN] = {
                    latency: latency,
                    success: true,
                    timestamp: Date.now(),
                    statusCode: response.status
                };

                console.log(`[${new Date().toISOString()}] 网络质量评估: ${DOMAIN} 延迟=${latency}ms, 状态=${response.status}`);

                // 如果延迟太高，尝试优化
                if (latency > 1000) {
                    console.log(`[${new Date().toISOString()}] 检测到高延迟(${latency}ms)，尝试优化网络...`);
                    this.optimizeNetwork();
                }
            })
            .catch(err => {
                console.error(`[${new Date().toISOString()}] 网络质量评估失败: ${err.message}`);

                this.networkQualityScores[DOMAIN] = {
                    success: false,
                    error: err.message,
                    timestamp: Date.now()
                };

                // 连接失败，尝试修复
                this.optimizeNetwork();
            });
    },

    // 优化网络连接
    optimizeNetwork: function () {
        console.log(`[${new Date().toISOString()}] 正在执行网络优化...`);

        // 1. 清除DNS缓存
        this.dnsCache.clear();

        try {
            // 2. 尝试系统级DNS刷新
            exec('ipconfig /flushdns', (err) => {
                if (err) {
                    console.error(`[${new Date().toISOString()}] 系统DNS刷新失败: ${err.message}`);
                } else {
                    console.log(`[${new Date().toISOString()}] 系统DNS缓存已刷新`);
                }
            });

            // 3. 检查网络接口
            exec('netsh interface show interface', (err, stdout) => {
                if (err) {
                    console.error(`[${new Date().toISOString()}] 网络接口检查失败: ${err.message}`);
                } else {
                    console.log(`[${new Date().toISOString()}] 网络接口状态检查完成`);
                }
            });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] 执行网络优化命令失败: ${err.message}`);
        }

        // 4. 重新检查网络连接
        setTimeout(() => {
            this.checkNetworkQuality();
        }, 15000); // 15秒后再次检查
    },

    // 设置路由切换
    setupRouteSwitching: function () {
        // 如果有备用域名/IP可在此处配置
        const originalRequest = axios.request;
        const self = this;

        // 替换axios请求函数，添加智能路由
        axios.request = function (config) {
            // 捕获请求开始时间
            const startTime = Date.now();

            // 标记请求，用于统计
            if (!config.metadata) {
                config.metadata = {};
            }
            config.metadata.startTime = startTime;

            // 添加超时和重试逻辑
            if (!config.timeout) {
                config.timeout = 20000; // 默认20秒超时
            }

            // 应用智能路由优化
            if (config.url && config.url.includes(DOMAIN)) {
                // 检查域名的历史性能，决定是否需要调整请求参数
                const qualityData = self.networkQualityScores[DOMAIN];
                if (qualityData && !qualityData.success) {
                    console.log(`[${new Date().toISOString()}] 检测到目标域名历史连接问题，应用智能路由优化...`);

                    // 增加请求超时时间
                    config.timeout = 30000;

                    // 添加额外的重试和恢复逻辑
                    config.headers = config.headers || {};
                    config.headers['Cache-Control'] = 'no-cache, no-store';
                }
            }

            // 发送请求并监控
            return originalRequest.call(this, config)
                .then(response => {
                    // 计算请求耗时
                    const duration = Date.now() - startTime;

                    // 更新路由性能统计
                    if (config.url) {
                        const hostname = new URL(config.url).hostname;
                        self.updateRoutePerformance(hostname, {
                            success: true,
                            duration: duration,
                            status: response.status
                        });
                    }

                    return response;
                })
                .catch(error => {
                    // 请求失败，更新路由性能统计
                    if (config.url) {
                        const hostname = new URL(config.url).hostname;
                        self.updateRoutePerformance(hostname, {
                            success: false,
                            error: error.message
                        });
                    }

                    throw error;
                });
        };
    },

    // 更新路由性能统计
    updateRoutePerformance: function (hostname, data) {
        if (!this.networkQualityScores[hostname]) {
            this.networkQualityScores[hostname] = {
                successCount: 0,
                failureCount: 0,
                totalDuration: 0,
                avgDuration: 0,
                history: []
            };
        }

        const stats = this.networkQualityScores[hostname];

        // 更新统计数据
        if (data.success) {
            stats.successCount++;
            stats.totalDuration += data.duration;
            stats.avgDuration = stats.totalDuration / stats.successCount;
        } else {
            stats.failureCount++;
        }

        // 保存最近10条历史记录
        stats.history.unshift({
            timestamp: Date.now(),
            ...data
        });

        if (stats.history.length > 10) {
            stats.history.pop();
        }

        // 输出性能统计
        if (stats.successCount + stats.failureCount >= 10) {
            const successRate = (stats.successCount / (stats.successCount + stats.failureCount) * 100).toFixed(2);
            console.log(`[${new Date().toISOString()}] 路由性能统计: ${hostname} - 成功率=${successRate}%, 平均延迟=${stats.avgDuration.toFixed(2)}ms`);
        }
    },

    // 安排网络诊断
    scheduleNetworkDiagnostics: function () {
        // 定期执行完整的网络诊断
        setInterval(() => {
            this.runNetworkDiagnostics();
        }, 30 * 60 * 1000); // 每30分钟

        // 首次延迟2分钟启动诊断
        setTimeout(() => {
            this.runNetworkDiagnostics();
        }, 2 * 60 * 1000);
    },

    // 运行网络诊断
    runNetworkDiagnostics: function () {
        if (!DOMAIN) return;

        console.log(`[${new Date().toISOString()}] 开始执行网络诊断...`);

        const diagnosticResults = {
            startTime: Date.now(),
            tests: []
        };

        // 检测网络连接类型
        try {
            exec('netsh wlan show interfaces', (err, stdout) => {
                if (!err && stdout.includes('SSID')) {
                    diagnosticResults.connectionType = 'WIFI';

                    // 提取WIFI信号强度
                    const signalMatch = stdout.match(/信号[\s]*:[\s]*(\d+)/i) || stdout.match(/Signal[\s]*:[\s]*(\d+)/i);
                    if (signalMatch) {
                        diagnosticResults.signalStrength = parseInt(signalMatch[1]);
                        console.log(`[${new Date().toISOString()}] 检测到WIFI连接，信号强度: ${diagnosticResults.signalStrength}%`);
                    }
                } else {
                    // 可能是有线连接
                    exec('netsh interface show interface', (err, stdout) => {
                        if (!err && stdout.includes('connected')) {
                            diagnosticResults.connectionType = 'WIRED';
                            console.log(`[${new Date().toISOString()}] 检测到有线网络连接`);
                        } else {
                            diagnosticResults.connectionType = 'UNKNOWN';
                        }
                    });
                }
            });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] 网络类型检测失败: ${err.message}`);
        }

        // 测试到目标服务器的连接质量
        this.testConnectionQuality(DOMAIN)
            .then(result => {
                diagnosticResults.targetLatency = result.latency;
                diagnosticResults.tests.push({
                    target: DOMAIN,
                    result: result
                });

                console.log(`[${new Date().toISOString()}] 网络诊断结果:`, diagnosticResults);

                // 更新诊断结果
                this.diagnosticResults = {
                    lastCheck: Date.now(),
                    latency: result.latency,
                    packetLoss: result.packetLoss,
                    jitter: result.jitter,
                    status: result.overallStatus
                };

                // 根据诊断结果优化网络
                if (result.overallStatus !== 'good') {
                    console.log(`[${new Date().toISOString()}] 网络状态不佳(${result.overallStatus})，执行智能优化`);
                    this.applySmartOptimization(result);
                }
            })
            .catch(err => {
                console.error(`[${new Date().toISOString()}] 连接质量测试失败: ${err.message}`);

                // 连接失败，尝试基本优化
                this.optimizeNetwork();
            });
    },

    // 测试连接质量
    testConnectionQuality: function (target) {
        return new Promise((resolve) => {
            const results = {
                latency: null,
                packetLoss: 0,
                jitter: null,
                testCount: 5,
                successCount: 0,
                latencies: []
            };

            const runTest = (testIndex) => {
                const startTime = Date.now();

                axios.get(`https://${target}`, {
                    timeout: 10000,
                    headers: { 'Cache-Control': 'no-cache' }
                })
                    .then(() => {
                        const latency = Date.now() - startTime;
                        results.successCount++;
                        results.latencies.push(latency);

                        // 继续下一次测试或完成
                        if (testIndex < results.testCount - 1) {
                            setTimeout(() => runTest(testIndex + 1), 1000);
                        } else {
                            // 计算结果
                            if (results.successCount > 0) {
                                results.latency = Math.round(results.latencies.reduce((sum, val) => sum + val, 0) / results.successCount);

                                // 计算抖动
                                if (results.latencies.length > 1) {
                                    let jitterSum = 0;
                                    for (let i = 1; i < results.latencies.length; i++) {
                                        jitterSum += Math.abs(results.latencies[i] - results.latencies[i - 1]);
                                    }
                                    results.jitter = Math.round(jitterSum / (results.latencies.length - 1));
                                }

                                // 计算丢包率
                                results.packetLoss = Math.round((1 - results.successCount / results.testCount) * 100);

                                // 总体状态评估
                                if (results.latency < 200 && results.packetLoss === 0 && results.jitter < 50) {
                                    results.overallStatus = 'good';
                                } else if (results.latency < 500 && results.packetLoss < 20 && results.jitter < 100) {
                                    results.overallStatus = 'fair';
                                } else {
                                    results.overallStatus = 'poor';
                                }
                            }

                            resolve(results);
                        }
                    })
                    .catch(() => {
                        // 测试失败
                        // 继续下一次测试或完成
                        if (testIndex < results.testCount - 1) {
                            setTimeout(() => runTest(testIndex + 1), 1000);
                        } else {
                            results.packetLoss = Math.round((1 - results.successCount / results.testCount) * 100);
                            results.overallStatus = 'poor';
                            resolve(results);
                        }
                    });
            };

            // 开始第一次测试
            runTest(0);
        });
    },

    // 应用智能优化
    applySmartOptimization: function (diagnosticResult) {
        console.log(`[${new Date().toISOString()}] 应用智能网络优化...`);

        // 根据诊断结果应用不同的优化策略
        if (diagnosticResult.packetLoss > 10) {
            // 高丢包率，可能是网络拥塞或不稳定
            console.log(`[${new Date().toISOString()}] 检测到高丢包率(${diagnosticResult.packetLoss}%)，调整网络参数...`);

            // 修改全局HTTP请求配置
            axios.defaults.timeout = 30000; // 增加超时
            axios.defaults.maxRedirects = 5; // 增加重定向次数

            // 修改WebSocket配置 - 改进WebSocket重连机制
            WebSocket.prototype.originalConnect = WebSocket.prototype.connect;
            WebSocket.prototype.connect = function () {
                // 添加自动重连属性
                this._reconnectAttempts = 0;
                this._maxReconnectAttempts = 10;
                this._reconnectInterval = 3000;
                
                // 存储原始URL以便重连
                this._wsUrl = this.url;
                
                this.addEventListener('error', (err) => {
                    console.log(`[${new Date().toISOString()}] WebSocket连接错误: ${err.message || '未知错误'}, 准备重连...`);
                    this._scheduleReconnect();
                });
                
                this.addEventListener('close', (event) => {
                    // 只有非正常关闭时才重连
                    if (!event.wasClean) {
                        console.log(`[${new Date().toISOString()}] WebSocket连接非正常关闭，准备重连...`);
                        this._scheduleReconnect();
                    }
                });
                
                return this.originalConnect.apply(this, arguments);
            };
            
            // 添加重连方法
            WebSocket.prototype._scheduleReconnect = function() {
                if (this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    console.log(`[${new Date().toISOString()}] 计划第${this._reconnectAttempts}次重连，${this._reconnectInterval}ms后尝试...`);
                    
                    // 增加重连间隔时间（指数退避）
                    const delay = Math.min(30000, this._reconnectInterval * Math.pow(1.5, this._reconnectAttempts - 1));
                    
                    setTimeout(() => {
                        if (this.readyState === WebSocket.CLOSED) {
                            console.log(`[${new Date().toISOString()}] 执行第${this._reconnectAttempts}次重连...`);
                            try {
                                // 创建新连接
                                const newWs = new WebSocket(this._wsUrl);
                                
                                // 复制事件处理器
                                this._copyEventListeners(this, newWs);
                                
                                // 更新引用
                                Object.assign(this, newWs);
                                
                                // 重置重连尝试次数
                                if (newWs.readyState === WebSocket.OPEN) {
                                    this._reconnectAttempts = 0;
                                }
                            } catch (e) {
                                console.error(`[${new Date().toISOString()}] 重连失败: ${e.message}`);
                                this._scheduleReconnect();
                            }
                        }
                    }, delay);
                } else {
                    console.error(`[${new Date().toISOString()}] 达到最大重连次数(${this._maxReconnectAttempts})，放弃重连`);
                }
            };
            
            // 复制事件监听器
            WebSocket.prototype._copyEventListeners = function(oldWs, newWs) {
                // 实现一个简单的事件监听器转移
                const eventTypes = ['message', 'open', 'close', 'error'];
                eventTypes.forEach(type => {
                    if (oldWs['on' + type]) {
                        newWs['on' + type] = oldWs['on' + type];
                    }
                });
            };
        }

        if (diagnosticResult.latency > 300) {
            // 高延迟，可能是路由问题
            console.log(`[${new Date().toISOString()}] 检测到高延迟(${diagnosticResult.latency}ms)，优化连接路由...`);

            // 刷新系统DNS和网络配置
            try {
                exec('ipconfig /renew', (err) => {
                    if (err) console.error(`IP更新失败: ${err.message}`);
                });
            } catch (err) {
                console.error(`执行网络命令失败: ${err.message}`);
            }
        }

        if (diagnosticResult.jitter > 50) {
            // 高抖动，可能是网络不稳定
            console.log(`[${new Date().toISOString()}] 检测到高抖动(${diagnosticResult.jitter}ms)，优化连接稳定性...`);

            // 实现更保守的重试策略
            axios.interceptors.response.use(undefined, function (error) {
                const config = error.config;
                if (!config || !config.retry) {
                    return Promise.reject(error);
                }

                // 设置变量，跟踪重试次数
                config.__retryCount = config.__retryCount || 0;

                // 检查我们是否已经用完所有重试
                if (config.__retryCount >= config.retry) {
                    return Promise.reject(error);
                }

                // 增加重试计数
                config.__retryCount += 1;
                console.log(`[${new Date().toISOString()}] 请求重试(${config.__retryCount}/${config.retry}): ${config.url}`);

                // 创建新的Promise
                const backoff = new Promise(function (resolve) {
                    setTimeout(function () {
                        resolve();
                    }, 1000 * (config.__retryCount || 1)); // 指数退避
                });

                // 返回Promise，触发重试
                return backoff.then(function () {
                    return axios(config);
                });
            });

            // 设置默认重试
            axios.defaults.retry = 3;
        }
    },

    // 刷新订阅链接
    refreshSubscription: function() {
        // 检查是否设置了有效的UUID
        if (!this.subRefreshStatus.subUUID) {
            console.error(`[${new Date().toISOString()}] 未设置有效的订阅UUID，跳过刷新`);
            return;
        }
        
        // 检查距离上次刷新时间是否太短（至少间隔5分钟）
        const currentTime = Date.now();
        const canRefreshNow = !this.subRefreshStatus.lastRefreshTime || 
            (currentTime - this.subRefreshStatus.lastRefreshTime) > 5 * 60 * 1000;
        
        if (!canRefreshNow) {
            console.log(`[${new Date().toISOString()}] 距离上次订阅刷新时间不足5分钟，跳过`);
            return;
        }
        
        // 确保DOMAIN变量有效
        if (!DOMAIN) {
            console.error(`[${new Date().toISOString()}] DOMAIN变量为空，无法构建订阅链接`);
            return;
        }
        
        // 构建订阅链接 - 使用当前设置的UUID
        const subUrl = `https://${DOMAIN}/sub/${this.subRefreshStatus.subUUID}`;
        console.log(`[${new Date().toISOString()}] 正在刷新订阅链接: ${subUrl}`);
        
        // 记录订阅刷新尝试
        logSystemActivity('subscription_refresh_attempt', {
            subUrl: subUrl,
            lastRefreshTime: this.subRefreshStatus.lastRefreshTime ? new Date(this.subRefreshStatus.lastRefreshTime).toISOString() : 'never',
            refreshCount: this.subRefreshStatus.refreshCount
        });
        
        // 标记为正在进行刷新，避免重复刷新
        this.subRefreshStatus.isRefreshing = true;
        
        // 发送请求刷新订阅
        axios.get(subUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Accept': 'text/plain; charset=utf-8'
            },
            // 使用validateStatus接受任何状态码，防止抛出异常
            validateStatus: () => true
        })
        .then(response => {
            // 无论结果如何，标记刷新完成
            this.subRefreshStatus.isRefreshing = false;
            
            if (response.status === 200) {
                this.subRefreshStatus.lastRefreshTime = currentTime;
                this.subRefreshStatus.refreshCount++;
                console.log(`[${new Date().toISOString()}] 订阅刷新成功，状态码: ${response.status}，总刷新次数: ${this.subRefreshStatus.refreshCount}`);
                
                // 记录订阅刷新成功
                logSystemActivity('subscription_refresh_success', {
                    status: response.status,
                    refreshCount: this.subRefreshStatus.refreshCount,
                    contentLength: response.data ? response.data.length : 0
                });
                
                // 确保response.data存在
                if (response.data) {
                    // 解码检查返回的内容是否正确
                    try {
                        const base64Content = response.data.trim();
                        const decodedContent = Buffer.from(base64Content, 'base64').toString('utf-8');
                        
                        // 修改：检查内容中是否包含正确的UUID，这里使用实际使用的UUID进行比对
                        // 注意：当前链接中应该使用提供的UUID，而不是subUUID或UUID
                        if (decodedContent.includes('vless://') && (
                            decodedContent.includes(this.subRefreshStatus.subUUID) || 
                            decodedContent.includes(UUID)
                        )) {
                            console.log(`[${new Date().toISOString()}] 订阅内容验证成功`);
                        } else {
                            console.error(`[${new Date().toISOString()}] 订阅内容验证失败，可能返回了错误内容`);
                            
                            // 记录订阅内容验证失败
                            logSystemActivity('subscription_content_invalid', {
                                contentPreview: base64Content.substring(0, 50) + '...'
                            });
                        }
                    } catch (e) {
                        console.error(`[${new Date().toISOString()}] 解析订阅内容失败: ${e.message}`);
                        
                        // 记录订阅内容解析失败
                        logSystemActivity('subscription_parse_failed', {
                            error: e.message
                        });
                    }
                } else {
                    console.error(`[${new Date().toISOString()}] 订阅刷新响应内容为空`);
                    
                    // 记录订阅内容为空
                    logSystemActivity('subscription_content_empty', {});
                }
            } else {
                console.error(`[${new Date().toISOString()}] 订阅刷新失败，异常状态码: ${response.status}`);
                
                // 记录订阅刷新失败
                logSystemActivity('subscription_refresh_failed', {
                    status: response.status,
                    error: "异常状态码"
                });
            }
        })
        .catch(err => {
            // 标记刷新完成
            this.subRefreshStatus.isRefreshing = false;
            
            console.error(`[${new Date().toISOString()}] 订阅刷新请求失败: ${err.message}`);
            
            // 记录订阅刷新请求失败
            logSystemActivity('subscription_refresh_error', {
                error: err.message,
                code: err.code || 'unknown'
            });
            
            // 如果是因为DNS或网络连接问题，尝试刷新DNS后重试
            if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ETIMEDOUT') {
                console.log(`[${new Date().toISOString()}] 检测到DNS/网络错误，尝试刷新DNS后重试...`);
                
                // 刷新DNS缓存
                try {
                    this.dnsCache.clear();
                    exec('ipconfig /flushdns', (execErr) => {
                        if (execErr) {
                            console.error(`[${new Date().toISOString()}] DNS缓存刷新失败: ${execErr.message}`);
                        } else {
                            console.log(`[${new Date().toISOString()}] DNS缓存已刷新，30秒后重试订阅刷新`);
                            
                            // 30秒后重试
                            setTimeout(() => {
                                if (this.subRefreshStatus.isRefreshing) {
                                    console.log(`[${new Date().toISOString()}] 已有刷新进行中，跳过重试`);
                                    return;
                                }
                                
                                this.subRefreshStatus.isRefreshing = true;
                                
                                axios.get(subUrl, {
                                    timeout: 15000, // 增加超时时间
                                    headers: {
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                                        'Cache-Control': 'no-cache',
                                        'Pragma': 'no-cache',
                                        'Accept': 'text/plain; charset=utf-8'
                                    },
                                    validateStatus: () => true
                                })
                                .then(retryResponse => {
                                    this.subRefreshStatus.isRefreshing = false;
                                    
                                    if (retryResponse.status === 200) {
                                        this.subRefreshStatus.lastRefreshTime = Date.now();
                                        this.subRefreshStatus.refreshCount++;
                                        console.log(`[${new Date().toISOString()}] 订阅重试刷新成功，状态码: ${retryResponse.status}`);
                                    } else {
                                        console.error(`[${new Date().toISOString()}] 订阅重试刷新失败，状态码: ${retryResponse.status}`);
                                    }
                                })
                                .catch(retryErr => {
                                    this.subRefreshStatus.isRefreshing = false;
                                    console.error(`[${new Date().toISOString()}] 订阅重试刷新请求失败: ${retryErr.message}`);
                                });
                            }, 30000);
                        }
                    });
                } catch (e) {
                    console.error(`[${new Date().toISOString()}] 执行DNS刷新失败: ${e.message}`);
                }
            }
        });
    },

    // 在WebSocket连接断开时刷新订阅
    handleWebSocketDisconnect: function(reason) {
        // 避免重复或不必要的刷新
        if (this.subRefreshStatus.isRefreshing) {
            console.log(`[${new Date().toISOString()}] WebSocket断开连接: ${reason}，已有刷新进行中，跳过`);
            return;
        }
        
        // 检查是否设置了订阅UUID
        if (!this.subRefreshStatus.subUUID) {
            console.error(`[${new Date().toISOString()}] WebSocket断开连接: ${reason}，但未设置有效的订阅UUID，跳过刷新`);
            return;
        }
        
        console.log(`[${new Date().toISOString()}] WebSocket断开连接: ${reason}，尝试刷新订阅`);
        this.refreshSubscription();
    },
};

httpServer.listen(PORT, () => {
    // 确保日志目录存在
    ensureLogDirectories();
    
    // 启动日志文件夹监控
    setupLogFolderMonitoring();
    
    // 记录服务启动
    logSystemActivity('service_start', {
        port: PORT,
        domain: DOMAIN,
        platform: `${os.platform()} ${os.release()}`,
        nodeVersion: process.version
    });
    
    runnz();
    setTimeout(() => {
        delFiles();
    }, 30000);

    // 初始化智能路由优化
    smartRouteOptimizer.initialize();

    // 初始化其他优化
    monitorConnectionStatus();
    enhanceTcpConnections();
    enhanceWebSocketHandling();
    setupKeepAliveAgent();

    // 启动预热
    preWarmService();

    // 添加自动保活任务
    addAccessTask();
    
    // 添加系统级活跃性维持
    setupSystemActivityKeeper();

    // 自我保活和健康检查机制
    const selfPingInterval = 5 * 60 * 1000; // 5分钟
    let failureCount = 0;
    const maxFailures = 3;

    // 自我健康检查
    setInterval(() => {
        try {
            http.get(`http://localhost:${PORT}`, res => {
                if (res.statusCode === 200) {
                    console.log(`[${new Date().toISOString()}] 自我健康检查成功，状态码: ${res.statusCode}`);
                    failureCount = 0; // 重置失败计数
                } else {
                    failureCount++;
                    console.error(`[${new Date().toISOString()}] 自我健康检查返回非200状态码: ${res.statusCode}, 失败计数: ${failureCount}/${maxFailures}`);

                    if (failureCount >= maxFailures) {
                        console.error(`[${new Date().toISOString()}] 连续${maxFailures}次健康检查失败，尝试重启服务`);
                        // 尝试重启服务
                        exec(`node index.js`, err => {
                            if (err) console.error('重启服务失败:', err.message);
                        });
                        failureCount = 0; // 重置失败计数
                    }
                }
            }).on('error', e => {
                failureCount++;
                console.error(`[${new Date().toISOString()}] 自我健康检查失败: ${e.message}, 失败计数: ${failureCount}/${maxFailures}`);

                if (failureCount >= maxFailures) {
                    console.error(`[${new Date().toISOString()}] 连续${maxFailures}次健康检查失败，尝试重启服务`);
                    // 尝试重启服务
                    exec(`node index.js`, err => {
                        if (err) console.error('重启服务失败:', err.message);
                    });
                    failureCount = 0; // 重置失败计数
                }
            });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] 执行自我健康检查出错:`, err.message);
        }
    }, selfPingInterval);

    // 设置持久化WebSocket连接保活
    if (DOMAIN) {
        const wsKeepAlive = () => {
            try {
                const wsUrl = `wss://${DOMAIN}`;
                console.log(`[${new Date().toISOString()}] 尝试建立WebSocket保活连接: ${wsUrl}`);

                const ws = new WebSocket(wsUrl);
                
                // 添加超时保护 - 防止连接挂起
                const connectionTimeout = setTimeout(() => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        console.error(`[${new Date().toISOString()}] WebSocket连接超时，强制关闭`);
                        try {
                            ws.terminate();
                            // 连接超时时刷新订阅
                            smartRouteOptimizer.handleWebSocketDisconnect('连接超时');
                        } catch (e) {}
                    }
                }, 15000); // 15秒连接超时

                ws.on('open', () => {
                    console.log(`[${new Date().toISOString()}] WebSocket保活连接成功建立`);
                    clearTimeout(connectionTimeout);

                    // 每30秒发送一次心跳包
                    const heartbeatInterval = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
                            console.log(`[${new Date().toISOString()}] WebSocket心跳包已发送`);
                        }
                    }, 30 * 1000);

                    // 设置响应超时 - 确保每次心跳都有响应
                    let heartbeatTimeout = null;
                    
                    // 设置心跳响应检查
                    const setHeartbeatCheck = () => {
                        clearTimeout(heartbeatTimeout);
                        heartbeatTimeout = setTimeout(() => {
                            console.error(`[${new Date().toISOString()}] WebSocket心跳响应超时，关闭连接并重新连接`);
                        clearInterval(heartbeatInterval);
                            try {
                                ws.close();
                            } catch (e) {}
                            setTimeout(wsKeepAlive, 5000);
                        }, 45 * 1000); // 45秒内必须收到响应
                    };
                    
                    // 初始心跳检查
                    setHeartbeatCheck();
                    
                    // 收到消息时重置心跳检查
                    ws.on('message', (data) => {
                        console.log(`[${new Date().toISOString()}] 收到WebSocket消息: ${data}`);
                        setHeartbeatCheck();
                    });

                    ws.on('close', (code, reason) => {
                        console.log(`[${new Date().toISOString()}] WebSocket保活连接已关闭，代码: ${code}, 原因: ${reason || '未知'}, 将在10秒后重新连接`);
                        clearInterval(heartbeatInterval);
                        clearTimeout(heartbeatTimeout);
                        
                        // 延迟重连时间随连续失败次数增加
                        const reconnectDelay = Math.min(60000, 10000 * Math.pow(1.5, wsKeepAlive.failCount || 0));
                        wsKeepAlive.failCount = (wsKeepAlive.failCount || 0) + 1;
                        
                        console.log(`[${new Date().toISOString()}] 连续失败次数: ${wsKeepAlive.failCount}, 重连延迟: ${reconnectDelay}ms`);
                        setTimeout(wsKeepAlive, reconnectDelay);
                    });

                    ws.on('error', (error) => {
                        console.error(`[${new Date().toISOString()}] WebSocket保活连接错误:`, error.message);
                        clearInterval(heartbeatInterval);
                        clearTimeout(heartbeatTimeout);
                        
                        try {
                        ws.close();
                        } catch (e) {}
                    });
                    
                    // 连接成功重置失败计数
                    wsKeepAlive.failCount = 0;
                });

                ws.on('error', (error) => {
                    console.error(`[${new Date().toISOString()}] 建立WebSocket保活连接失败:`, error.message);
                    clearTimeout(connectionTimeout);
                    
                    // 发生错误，增加失败计数
                    wsKeepAlive.failCount = (wsKeepAlive.failCount || 0) + 1;
                    
                    // 延迟时间随失败次数增加，最多30秒
                    const retryDelay = Math.min(30000, 5000 * Math.pow(1.5, wsKeepAlive.failCount - 1));
                    console.log(`[${new Date().toISOString()}] 将在${retryDelay}ms后重试，当前失败次数: ${wsKeepAlive.failCount}`);
                    
                    setTimeout(wsKeepAlive, retryDelay);
                });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] WebSocket保活连接异常:`, err.message);
                
                // 发生异常，增加失败计数
                wsKeepAlive.failCount = (wsKeepAlive.failCount || 0) + 1;
                const retryDelay = Math.min(30000, 5000 * Math.pow(1.5, wsKeepAlive.failCount - 1));
                
                // 连接异常时刷新订阅
                smartRouteOptimizer.handleWebSocketDisconnect('连接异常: ' + err.message);
                
                setTimeout(wsKeepAlive, retryDelay);
            }
        };

        // 启动WebSocket保活
        setTimeout(wsKeepAlive, 10 * 1000); // 服务启动10秒后开始WebSocket保活
        
        // 设置连接愈合机制 - 在检测到问题时尝试修复连接
        const connectionHealer = () => {
            // 添加DNS预解析
            try {
                const dns = require('dns');
                dns.resolve4(DOMAIN, (err, addresses) => {
                    if (!err && addresses.length > 0) {
                        console.log(`[${new Date().toISOString()}] DNS预解析成功: ${DOMAIN} -> ${addresses.join(', ')}`);
                    } else if (err) {
                        console.error(`[${new Date().toISOString()}] DNS预解析失败: ${err.message}`);
                        
                        // DNS解析失败，尝试刷新DNS缓存
                        exec('ipconfig /flushdns', (err) => {
                            if (err) console.error('DNS缓存刷新失败:', err.message);
                        });
                    }
                });
            } catch (e) {
                console.error(`[${new Date().toISOString()}] 执行DNS预解析出错:`, e.message);
            }
            
            // 检查连接可用性
            try {
                axios.get(`https://${DOMAIN}`, {
                    timeout: 10000,
                    validateStatus: () => true // 接受任何状态码
                })
                .then(response => {
                    console.log(`[${new Date().toISOString()}] 连接可用性检查: 状态码=${response.status}`);
                    
                    // 如果状态码不正常，尝试重置连接
                    if (response.status < 200 || response.status >= 400) {
                        console.error(`[${new Date().toISOString()}] 检测到异常状态码(${response.status})，执行连接重置`);
                        
                        // 重启WebSocket服务
                        try {
                            // 关闭所有当前WebSocket连接
                            wss.clients.forEach(client => {
                                try {
                                    client.terminate();
                                } catch (e) {}
                            });
                            
                            // 触发重新连接
                            setTimeout(wsKeepAlive, 5000);
                        } catch (e) {
                            console.error(`[${new Date().toISOString()}] 连接重置失败:`, e.message);
                        }
                    }
                })
                .catch(err => {
                    console.error(`[${new Date().toISOString()}] 连接可用性检查失败:`, err.message);
                    
                    // 连接检查失败，尝试修复
                    try {
                        // 刷新DNS
                        exec('ipconfig /flushdns', (err) => {
                            if (err) console.error('DNS缓存刷新失败:', err.message);
                        });
                        
                        // 重置网络接口
                        console.log(`[${new Date().toISOString()}] 尝试重置网络连接...`);
                        
                        // 重启连接
                        setTimeout(wsKeepAlive, 10000);
                    } catch (e) {
                        console.error(`[${new Date().toISOString()}] 修复连接失败:`, e.message);
                    }
                });
            } catch (e) {
                console.error(`[${new Date().toISOString()}] 执行连接检查出错:`, e.message);
            }
        };
        
        // 每10分钟运行一次连接愈合
        setInterval(connectionHealer, 10 * 60 * 1000);
        
        // 初次延迟5分钟后开始运行
        setTimeout(connectionHealer, 5 * 60 * 1000);
    }

    // 添加WebSocket连接监控与自动恢复机制
    const monitorWebSocketConnections = () => {
        console.log(`[${new Date().toISOString()}] 启动WebSocket连接监控器`);

        // 记录连接状态
        const wsStats = {
            activeConnections: 0,
            totalConnections: 0,
            closedConnections: 0,
            errorConnections: 0,
            lastConnectionTime: null,
            consecutiveErrors: 0,
            healthyServer: true
        };

        // 监控已有的WebSocket服务器
        const originalWsOn = wss.on;
        wss.on = function(event, callback) {
            if (event === 'connection') {
                return originalWsOn.call(this, event, function(ws, ...args) {
                    // 更新统计
                    wsStats.activeConnections++;
                    wsStats.totalConnections++;
                    wsStats.lastConnectionTime = new Date();
                    wsStats.consecutiveErrors = 0; // 有新连接表示服务正常

                    // 监听连接关闭
                    ws.on('close', (code, reason) => {
                        wsStats.activeConnections--;
                        wsStats.closedConnections++;
                        
                        // 记录非正常关闭
                        if (code !== 1000 && code !== 1001) {
                            console.log(`[${new Date().toISOString()}] WebSocket非正常关闭, 代码: ${code}, 原因: ${reason || '未知'}`);
                        }
                    });

                    // 监听错误
                    ws.on('error', (err) => {
                        wsStats.errorConnections++;
                        wsStats.consecutiveErrors++;
                        
                        if (wsStats.consecutiveErrors > 3) {
                            console.error(`[${new Date().toISOString()}] 检测到连续WebSocket错误(${wsStats.consecutiveErrors}次), 可能服务不健康`);
                            wsStats.healthyServer = false;
                            
                            // 触发服务自我恢复
                            if (wsStats.consecutiveErrors > 5) {
                                console.error(`[${new Date().toISOString()}] 尝试重置WebSocket服务器...`);
                                
                                // 尝试重建WebSocket服务器
                                try {
                                    const newWss = new WebSocket.Server({ server: httpServer });
                                    const oldWss = wss;
                                    
                                    // 转移所有事件监听器
                                    for (const event of ['connection', 'error', 'close']) {
                                        const listeners = oldWss.listeners(event);
                                        listeners.forEach(listener => {
                                            newWss.on(event, listener);
                        });
                                    }
                                    
                                    // 替换全局wss引用
                                    wss = newWss;
                                    
                                    // 关闭旧服务器
                                    setTimeout(() => {
                                        try {
                                            oldWss.close();
                                        } catch (e) {}
                                    }, 5000);
                                    
                                    // 重置统计
                                    wsStats.consecutiveErrors = 0;
                                    wsStats.healthyServer = true;
                                    
                                    console.log(`[${new Date().toISOString()}] WebSocket服务器已重置`);
                                } catch (e) {
                                    console.error(`[${new Date().toISOString()}] 重置WebSocket服务器失败: ${e.message}`);
                                }
                            }
                        }
                    });
                    
                    return callback.call(this, ws, ...args);
                });
            }
            return originalWsOn.apply(this, arguments);
        };

        // 定期输出WebSocket连接状态
        setInterval(() => {
            console.log(`[${new Date().toISOString()}] WebSocket状态:`, {
                活跃连接: wsStats.activeConnections,
                总连接数: wsStats.totalConnections,
                已关闭: wsStats.closedConnections,
                错误连接: wsStats.errorConnections,
                最近连接时间: wsStats.lastConnectionTime,
                服务健康: wsStats.healthyServer ? '是' : '否'
            });
            
            // 检查长时间无连接的情况
            const nowTime = new Date();
            if (wsStats.lastConnectionTime && 
                wsStats.activeConnections === 0 && 
                (nowTime - wsStats.lastConnectionTime) > 20 * 60 * 1000) { // 20分钟无连接
                
                console.error(`[${new Date().toISOString()}] 检测到20分钟无活跃WebSocket连接，尝试服务自愈...`);
                
                // 重启服务
                try {
                    exec(`node index.js`, err => {
                        if (err) console.error('重启服务失败:', err.message);
                    });
                } catch (e) {
                    console.error(`[${new Date().toISOString()}] 重启服务失败: ${e.message}`);
                }
            }
        }, 5 * 60 * 1000); // 每5分钟检查一次
    };

    // 添加TCP连接跟踪和恢复
    const enhanceTcpTracking = () => {
        // 跟踪所有活跃的TCP连接
        const activeTcpConnections = new Set();
        
        // 拦截TCP Socket创建
        const originalCreateConnection = net.createConnection;
        net.createConnection = function(options, ...args) {
            const socket = originalCreateConnection.apply(this, arguments);
            
            // 添加到活跃连接集合
            activeTcpConnections.add(socket);
            
            // 记录TCP连接创建
            const connectionInfo = {
                host: typeof options === 'object' ? options.host : 'unknown',
                port: typeof options === 'object' ? options.port : 'unknown',
                localAddress: socket.localAddress,
                localPort: socket.localPort,
                remoteAddress: socket.remoteAddress,
                remotePort: socket.remotePort
            };
            logSystemActivity('tcp_connection_created', connectionInfo);
            
            // 设置超时处理
            socket.setTimeout(60000); // 60秒超时
            
            // 重写事件处理
            const originalOn = socket.on;
            socket.on = function(event, listener) {
                if (event === 'close') {
                    return originalOn.call(this, event, function(...args) {
                        // 从活跃连接中移除
                        activeTcpConnections.delete(socket);
                        
                        // 记录TCP连接关闭
                        logSystemActivity('tcp_connection_closed', {
                            hadError: args[0],
                            host: typeof options === 'object' ? options.host : 'unknown',
                            port: typeof options === 'object' ? options.port : 'unknown',
                            remoteAddress: socket.remoteAddress,
                            remotePort: socket.remotePort
                        });
                        
                        listener.apply(this, args);
                    });
                } else if (event === 'timeout') {
                    return originalOn.call(this, event, function(...args) {
                        console.error(`[${new Date().toISOString()}] TCP连接超时: ${this.remoteAddress}:${this.remotePort}`);
                        
                        // 记录TCP连接超时
                        logSystemActivity('tcp_connection_timeout', {
                            host: typeof options === 'object' ? options.host : 'unknown',
                            port: typeof options === 'object' ? options.port : 'unknown',
                            remoteAddress: this.remoteAddress,
                            remotePort: this.remotePort
                        });
                        
                        // 尝试重置连接
                        try {
                            this.destroy();
                        } catch (e) {}
                        listener.apply(this, args);
                    });
                } else if (event === 'error') {
                    return originalOn.call(this, event, function(...args) {
                        console.error(`[${new Date().toISOString()}] TCP连接错误: ${args[0]?.message || '未知'}`);
                        
                        // 记录TCP连接错误
                        logSystemActivity('tcp_connection_error', {
                            error: args[0]?.message || '未知',
                            host: typeof options === 'object' ? options.host : 'unknown',
                            port: typeof options === 'object' ? options.port : 'unknown',
                            remoteAddress: this.remoteAddress,
                            remotePort: this.remotePort
                        });
                        
                        listener.apply(this, args);
                    });
                }
                return originalOn.apply(this, arguments);
            };
            
            return socket;
        };
        
        // 定期检查所有活跃连接
        setInterval(() => {
            console.log(`[${new Date().toISOString()}] 当前活跃TCP连接: ${activeTcpConnections.size}`);
            
            // 记录TCP连接状态
            logSystemActivity('tcp_connections_status', {
                activeConnections: activeTcpConnections.size,
                connections: Array.from(activeTcpConnections).map(socket => {
                    try {
                        return {
                            localAddress: socket.localAddress,
                            localPort: socket.localPort,
                            remoteAddress: socket.remoteAddress,
                            remotePort: socket.remotePort,
                            destroyed: socket.destroyed
                        };
                    } catch (e) {
                        return { error: e.message };
                    }
                }).slice(0, 10) // 限制记录数量
            });
            
            // 检查和清理挂起的连接
            activeTcpConnections.forEach(socket => {
                if (socket.destroyed) {
                    activeTcpConnections.delete(socket);
                }
            });
        }, 10 * 60 * 1000); // 每10分钟
    };

    // 初始化连接监控
    monitorWebSocketConnections();
    enhanceTcpTracking();

    console.log(`服务器运行在端口 ${PORT}，已启用智能路由优化和高级网络管理`);
});

// 系统级活跃性维持
const setupSystemActivityKeeper = () => {
    console.log(`[${new Date().toISOString()}] 启动系统级活跃性维持...`);
    
    // 活跃性统计数据
    const activityStats = {
        cpuActivities: 0,
        fileActivities: 0,
        memoryActivities: 0,
        startTime: Date.now()
    };
    
    // 1. CPU活跃性 - 每3分钟执行简单计算，保持CPU活跃
    const cpuActivity = () => {
        let result = 0;
        const iterations = 10000 + Math.floor(Math.random() * 5000);
        
        console.log(`[${new Date().toISOString()}] 执行CPU活跃操作 (${iterations}次迭代)...`);
        
        // 执行一些简单的计算
        for (let i = 0; i < iterations; i++) {
            result += Math.sqrt(i) * Math.sin(i);
            if (i % 1000 === 0) {
                // 防止JS引擎优化掉循环
                process.stdout.write('');
            }
        }
        
        activityStats.cpuActivities++;
        console.log(`[${new Date().toISOString()}] CPU活跃操作完成，累计执行次数: ${activityStats.cpuActivities}`);
        
        // 记录CPU活动
        logSystemActivity('cpu_activity', {
            iterations: iterations,
            totalActivities: activityStats.cpuActivities,
            result: Math.round(result)
        });
    };
    
    // 2. 文件系统活跃性 - 每5分钟创建、写入、读取和删除临时文件
    const fileActivity = () => {
        const tempFilePath = os.tmpdir() + '/system_activity_' + Date.now() + '.tmp';
        
        console.log(`[${new Date().toISOString()}] 执行文件系统活跃操作...`);
        
        try {
            // 写入临时文件
            fs.writeFileSync(tempFilePath, `活跃性测试 ${new Date().toISOString()}\n系统运行时间: ${Math.floor((Date.now() - activityStats.startTime) / 1000)}秒`);
            
            // 读取临时文件
            const data = fs.readFileSync(tempFilePath, 'utf8');
            
            // 删除临时文件
            fs.unlinkSync(tempFilePath);
            
            activityStats.fileActivities++;
            console.log(`[${new Date().toISOString()}] 文件系统活跃操作完成，累计执行次数: ${activityStats.fileActivities}`);
            
            // 记录文件活动
            logSystemActivity('file_activity', {
                filePath: tempFilePath,
                totalActivities: activityStats.fileActivities,
                fileContent: data.substring(0, 50) + '...'
            });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] 文件系统活跃操作失败:`, err.message);
            
            // 记录失败的文件活动
            logSystemActivity('file_activity_failed', {
                filePath: tempFilePath,
                error: err.message
            });
        }
    };
    
    // 3. 内存活跃性 - 每7分钟分配和释放内存
    const memoryActivity = () => {
        console.log(`[${new Date().toISOString()}] 执行内存活跃操作...`);
        
        try {
            // 当前内存使用情况
            const initialMemory = process.memoryUsage();
            
            // 创建并填充大型数组，然后释放
            const size = 1024 * 1024 * 5; // 分配约5MB内存
            let arr = new Array(size);
            for (let i = 0; i < size; i += 1024) {
                arr[i] = i;
            }
            
            // 使用数组进行一些操作
            let sum = 0;
            for (let i = 0; i < 1000; i++) {
                sum += arr[i * 1024] || 0;
            }
            
            // 强制GC不可靠，直接将数组设为null
            arr = null;
            
            // 记录内存变化
            const afterMemory = process.memoryUsage();
            console.log(`[${new Date().toISOString()}] 内存活跃操作完成，堆内存变化: ${Math.round((afterMemory.heapUsed - initialMemory.heapUsed) / 1024)}KB`);
            
            activityStats.memoryActivities++;
            console.log(`[${new Date().toISOString()}] 内存活跃操作完成，累计执行次数: ${activityStats.memoryActivities}`);
            
            // 记录内存活动
            logSystemActivity('memory_activity', {
                totalActivities: activityStats.memoryActivities,
                initialHeapUsed: `${Math.round(initialMemory.heapUsed / (1024 * 1024))}MB`,
                afterHeapUsed: `${Math.round(afterMemory.heapUsed / (1024 * 1024))}MB`,
                memoryChange: `${Math.round((afterMemory.heapUsed - initialMemory.heapUsed) / 1024)}KB`
            });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] 内存活跃操作失败:`, err.message);
            
            // 记录失败的内存活动
            logSystemActivity('memory_activity_failed', {
                error: err.message
            });
        }
    };

    // 4. 周期性执行所有活跃性操作
    const runAllActivities = () => {
        // 打印活跃性统计
        const uptime = Math.floor((Date.now() - activityStats.startTime) / 1000);
        console.log(`[${new Date().toISOString()}] 系统活跃性统计 - 运行时间: ${Math.floor(uptime / 3600)}小时${Math.floor((uptime % 3600) / 60)}分钟, CPU: ${activityStats.cpuActivities}次, 文件: ${activityStats.fileActivities}次, 内存: ${activityStats.memoryActivities}次`);
        
        // 执行所有活跃性操作
        cpuActivity();
        fileActivity();
        memoryActivity();
    };

    // 5. 定期执行系统活跃性操作 
    const activityInterval = 15 * 60 * 1000; // 每15分钟
    setInterval(runAllActivities, activityInterval);
    
    // 初次运行延迟30秒，让系统先启动完成
    setTimeout(runAllActivities, 30 * 1000);
    
    // 随机时间间隔执行CPU活跃操作，更自然
    const scheduleRandomCpuActivity = () => {
        // 在5-10分钟之间随机选择时间间隔
        const randomInterval = (5 * 60 * 1000) + Math.floor(Math.random() * (5 * 60 * 1000));
        
        setTimeout(() => {
            cpuActivity();
            scheduleRandomCpuActivity(); // 递归调度下一次活动
        }, randomInterval);
    };
    
    // 启动随机CPU活跃
    scheduleRandomCpuActivity();
    
    // 6. 监控系统资源状态
    setInterval(() => {
        const memoryInfo = process.memoryUsage();
        const memoryUsed = Math.round(memoryInfo.rss / (1024 * 1024));
        const heapUsed = Math.round(memoryInfo.heapUsed / (1024 * 1024));
        const uptime = process.uptime();
        
        console.log(`[${new Date().toISOString()}] 系统资源监控 - 内存使用: ${memoryUsed}MB, 堆内存: ${heapUsed}MB, 运行时间: ${Math.floor(uptime / 3600)}小时${Math.floor((uptime % 3600) / 60)}分钟`);
        
        // 如果内存使用过高，主动触发垃圾回收
        if (heapUsed > 100) { // 堆内存超过100MB
            console.log(`[${new Date().toISOString()}] 检测到堆内存使用较高(${heapUsed}MB)，尝试释放...`);
            
            // 手动触发垃圾回收（尽管不可靠，但可能有助于释放一些内存）
            try {
                global.gc();
                console.log(`[${new Date().toISOString()}] 手动垃圾回收完成`);
            } catch (e) {
                console.log(`[${new Date().toISOString()}] 手动垃圾回收不可用，需使用--expose-gc参数启动Node`);
            }
        }
    }, 30 * 60 * 1000); // 每30分钟
};
