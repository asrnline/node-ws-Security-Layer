const os = require('os');
const http = require('http');
const fs = require('fs');
const axios = require('axios');
const net = require('net');
const { Buffer } = require('buffer');
const { exec, execSync } = require('child_process');
const { WebSocket, createWebSocketStream } = require('ws');
const UUID = process.env.UUID || 'de04add9-5c68-6bab-950c-08cd5320df33'; // 运行哪吒v1,在不同的平台需要改UUID,否则会被覆盖
const SUB_UUID = process.env.SUB_UUID || UUID; // 用于验证订阅访问的UUID，默认使用主UUID
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';       // 哪吒v1填写形式：nz.abc.com:8008   哪吒v0填写形式：nz.abc.com
const NEZHA_PORT = process.env.NEZHA_PORT || '';           // 哪吒v1没有此变量，v0的agent端口为{443,8443,2096,2087,2083,2053}其中之一时开启tls
const NEZHA_KEY = process.env.NEZHA_KEY || '';             // v1的NZ_CLIENT_SECRET或v0的agent端口                
const DOMAIN = process.env.DOMAIN || '1234.abc.com';        // 填写项目域名或已反代的域名，不带前缀，建议填已反代的域名
const AUTO_ACCESS = process.env.AUTO_ACCESS || true;      // 是否开启自动访问保活,false为关闭,true为开启,需同时填写DOMAIN变量
const SUB_PATH = process.env.SUB_PATH || 'sub';            // 获取节点的订阅路径
const NAME = process.env.NAME || 'Vls';                    // 节点名称
const PORT = process.env.PORT || 30325;                     // http和ws服务端口

const metaInfo = execSync(
    'curl -s https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
    { encoding: 'utf-8' }
);
const ISP = metaInfo.trim();
const httpServer = http.createServer((req, res) => {
    console.log(`[${new Date().toISOString()}] 收到请求: ${req.url}`);

    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello, World\n');
    } else if (req.url.startsWith(`/${SUB_PATH}/`)) {
        // 提取URL中的UUID部分 - 更灵活地处理路径格式
        const uuidMatch = req.url.match(new RegExp(`/${SUB_PATH}/([^/]+)`));
        const providedUUID = uuidMatch ? uuidMatch[1] : '';

        console.log(`[${new Date().toISOString()}] 订阅请求 - 提供的UUID: ${providedUUID}, 期望的UUID: ${SUB_UUID}`);

        // 验证UUID是否匹配
        if (providedUUID && (providedUUID === SUB_UUID || providedUUID === UUID)) {
            const vlessURL = `vless://${UUID}@www.visa.com.tw:443?encryption=none&security=tls&sni=${DOMAIN}&type=ws&host=${DOMAIN}&path=%2F#${NAME}-${ISP}`;
            const base64Content = Buffer.from(vlessURL).toString('base64');

            console.log(`[${new Date().toISOString()}] 订阅请求成功 - UUID验证通过`);

            res.writeHead(200, {
                'Content-Type': 'text/plain',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            });
            res.end(base64Content + '\n');
        } else {
            // UUID不匹配，返回404
            console.log(`[${new Date().toISOString()}] 订阅请求失败 - UUID不匹配或为空`);

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found\n');
        }
    } else if (req.url === `/${SUB_PATH}`) {
        // 旧的订阅链接 - 提供更友好的错误信息
        console.log(`[${new Date().toISOString()}] 收到旧格式订阅请求，未提供UUID`);

        res.writeHead(400, { 'Content-Type': 'text/plain' });
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
        (Date.now() - wsConnStats.lastConnectionTime.getTime()) > 10 * 60 * 1000) {
        console.error(`[${new Date().toISOString()}] 检测到WebSocket服务器长时间无活跃连接，尝试重置...`);
        try {
            // 关闭并重建WebSocket服务器
            const newWss = new WebSocket.Server({ server: httpServer });
            const oldWss = wss;
            
            // 转移连接处理逻辑
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
            }, 5000);
            
            console.log(`[${new Date().toISOString()}] WebSocket服务器已重置`);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 重置WebSocket服务器失败: ${e.message}`);
        }
    }
}, 5 * 60 * 1000); // 每5分钟检查一次

// 配置WebSocket服务器
function setupWsServer(wsServer) {
    wsServer.on('connection', ws => {
        // 更新连接统计
        wsConnStats.activeConnections++;
        wsConnStats.totalConnections++;
        wsConnStats.lastConnectionTime = new Date();
        
        // 设置连接属性
        ws.isAlive = true;
        ws.connTime = Date.now();
        
        // 设置ping超时检测 - 60秒无响应则断开
        const resetPingTimeout = () => {
            clearTimeout(ws.pingTimeout);
            ws.pingTimeout = setTimeout(() => {
                console.error(`[${new Date().toISOString()}] WebSocket连接心跳超时，关闭连接`);
                ws.terminate();
            }, 60000);
        };
        
        // 初始化ping超时
        resetPingTimeout();
        
        // 设置心跳检测 - 每15秒ping一次
        ws.pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
                console.log(`[${new Date().toISOString()}] 发送ping心跳`);
            }
        }, 15000);
        
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
            
            console.log(`[${new Date().toISOString()}] WebSocket连接关闭，代码: ${code}, 原因: ${reason || '未知'}, 持续时间: ${(Date.now() - ws.connTime) / 1000}秒`);
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

            // 1. 更频繁的短间隔保活 - 每30秒访问一次
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
            }, 30 * 1000); // 每30秒

            // 2. 中间隔保活 - 每3分钟发送带有较长超时的请求
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
            }, 3 * 60 * 1000); // 每3分钟

            // 3. 长间隔保活 - 每10分钟进行一次更复杂的访问（模拟真实用户）
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
            }, 10 * 60 * 1000); // 每10分钟
            
            // 4. 添加连接健康检查 - 每分钟运行
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
            }, 60 * 1000); // 每1分钟
            
            // 5. 随机间隔保活 - 随机时间间隔请求，避免被防火墙检测到规律
            const scheduleRandomCheck = () => {
                // 随机间隔5-30秒
                const randomInterval = 5000 + Math.floor(Math.random() * 25000);
                
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
        
        // 每30秒检查一次连接状态
        setInterval(() => {
            this.checkConnectionStatus();
        }, 30 * 1000);
        
        // 初始检查延迟2分钟，让系统先稳定
        setTimeout(() => {
            this.checkConnectionStatus();
        }, 2 * 60 * 1000);
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
        this.failureCounter++;
        console.error(`[${new Date().toISOString()}] 连接检查失败(${this.failureCounter}/${this.maxAllowedFailures}): ${reason}`);
        
        // 如果连续失败次数达到阈值，执行恢复操作
        if (this.failureCounter >= this.maxAllowedFailures) {
            const currentTime = Date.now();
            const canRecoverNow = !this.lastRecoveryTime || 
                (currentTime - this.lastRecoveryTime) > 10 * 60 * 1000; // 两次恢复至少间隔10分钟
            
            if (canRecoverNow) {
                console.error(`[${new Date().toISOString()}] 检测到持续连接问题，启动自动恢复流程`);
                this.performRecovery();
                this.lastRecoveryTime = currentTime;
                this.failureCounter = 0;
            } else {
                console.log(`[${new Date().toISOString()}] 已达到恢复阈值，但距离上次恢复时间不足10分钟，暂时跳过`);
            }
        }
    },
    
    // 执行恢复操作
    performRecovery: function() {
        console.log(`[${new Date().toISOString()}] 执行网络连接恢复操作...`);
        
        // 步骤1: 刷新DNS缓存
        try {
            this.dnsCache.clear();
            exec('ipconfig /flushdns', (err) => {
                if (err) console.error(`[${new Date().toISOString()}] DNS缓存刷新失败: ${err.message}`);
                else console.log(`[${new Date().toISOString()}] DNS缓存已刷新`);
            });
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 执行DNS刷新失败: ${e.message}`);
        }
        
        // 步骤2: 重置网络接口连接
        try {
            console.log(`[${new Date().toISOString()}] 尝试重置网络连接...`);
            
            // 检查网络接口状态
            exec('netsh interface show interface', (err, stdout) => {
                if (err) {
                    console.error(`[${new Date().toISOString()}] 网络接口检查失败: ${err.message}`);
                } else {
                    console.log(`[${new Date().toISOString()}] 网络接口状态检查完成`);
                }
            });
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 执行网络接口重置失败: ${e.message}`);
        }
        
        // 步骤3: 重建WebSocket服务器
        try {
            console.log(`[${new Date().toISOString()}] 重建WebSocket服务器...`);
            
            // 创建新的WebSocket服务器
            const newWss = new WebSocket.Server({ server: httpServer });
            const oldWss = wss;
            
            // 设置新服务器
            setupWsServer(newWss);
            
            // 更新全局变量
            wss = newWss;
            
            // 关闭旧服务器
            setTimeout(() => {
                try {
                    oldWss.close();
                    console.log(`[${new Date().toISOString()}] 旧WebSocket服务器已关闭`);
                } catch (e) {
                    console.error(`[${new Date().toISOString()}] 关闭旧WebSocket服务器失败: ${e.message}`);
                }
            }, 5000);
            
            console.log(`[${new Date().toISOString()}] WebSocket服务器已重建`);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 重建WebSocket服务器失败: ${e.message}`);
        }
        
        // 步骤4: 重启保活机制
        try {
            console.log(`[${new Date().toISOString()}] 重启保活机制...`);
            
            // 重新加入外部保活服务
            if (DOMAIN) {
                const fullURL = `https://${DOMAIN}`;
                const command = `curl -X POST "https://oooo.serv00.net/add-url" -H "Content-Type: application/json" -d '{"url": "${fullURL}"}'`;
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`[${new Date().toISOString()}] 重新添加保活任务失败:`, error.message);
                    } else {
                        console.log(`[${new Date().toISOString()}] 已重新添加保活任务:`, stdout);
                    }
                });
            }
        } catch (e) {
            console.error(`[${new Date().toISOString()}] 重启保活机制失败: ${e.message}`);
        }
        
        // 步骤5: 进行网络诊断
        setTimeout(() => {
            this.runNetworkDiagnostics();
        }, 30 * 1000); // 30秒后执行诊断
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
    }
};

httpServer.listen(PORT, () => {
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
            
            // 设置超时处理
            socket.setTimeout(60000); // 60秒超时
            
            // 重写事件处理
            const originalOn = socket.on;
            socket.on = function(event, listener) {
                if (event === 'close') {
                    return originalOn.call(this, event, (...args) => {
                        // 从活跃连接中移除
                        activeTcpConnections.delete(socket);
                        listener.apply(this, args);
                    });
                } else if (event === 'timeout') {
                    return originalOn.call(this, event, (...args) => {
                        console.error(`[${new Date().toISOString()}] TCP连接超时: ${this.remoteAddress}:${this.remotePort}`);
                        // 尝试重置连接
                        try {
                            this.destroy();
                        } catch (e) {}
                        listener.apply(this, args);
                    });
                } else if (event === 'error') {
                    return originalOn.call(this, event, (...args) => {
                        console.error(`[${new Date().toISOString()}] TCP连接错误: ${args[0]?.message || '未知'}`);
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
