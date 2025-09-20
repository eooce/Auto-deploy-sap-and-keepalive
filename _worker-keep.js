// 环境变量配置(必填)
let email = "你的sap登录邮箱";      // SAP登录邮箱,直接填写或设置环境变量，变量名：EMAIL
let password = "你的sap登录密码";   // SAP登录密码,直接填写或设置环境变量，变量名：PASSWORD

// 离线重启通知 Telegram配置(可选)
let CHAT_ID = "";    // Telegram聊天CHAT_ID,直接填写或设置环境变量，变量名：CHAT_ID
let BOT_TOKEN = "";  // Telegram机器人TOKEN,直接填写或设置环境变量，变量名：BOT_TOKEN

// 应用配置 URL和应用名称配置(必填)
const MONITORED_APPS = [ // 格式: {url: "应用URL", name: "应用名称"}
  {url: "https://xxxxx.cfapps.ap21.hana.ondemand.com", name: "xxxxx"},  
  {url: "https://xxxxx.cfapps.us10-001.hana.ondemand.com", name: "xxxxx"}
];

// 区域固定常量(无需更改)
const REGIONS = {
  US: {
    CF_API: "https://api.cf.us10-001.hana.ondemand.com",
    UAA_URL: "https://uaa.cf.us10-001.hana.ondemand.com",
    DOMAIN_PATTERN: /\.us10(-001)?\.hana\.ondemand\.com$/
  },
  AP: {
    CF_API: "https://api.cf.ap21.hana.ondemand.com",
    UAA_URL: "https://uaa.cf.ap21.hana.ondemand.com",
    DOMAIN_PATTERN: /\.ap21\.hana\.ondemand\.com$/
  }
};

// 工具函数
const pad = n => String(n).padStart(2, "0");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (o, c = 200) => new Response(JSON.stringify(o), {
  status: c,
  headers: { "content-type": "application/json" }
});

// Telegram 消息发送
async function sendTelegramMessage(message) {
  // 如果没有配置 Telegram 参数，则忽略
  if (!CHAT_ID || !BOT_TOKEN || CHAT_ID === "your-chat-id" || BOT_TOKEN === "your-telegram-bot-token") {
    console.log("[telegram] Telegram 未配置，跳过发送消息");
    return;
  }

  try {
    const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(telegramUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });

    const result = await response.json();
    if (!response.ok) {
      console.error(`[telegram-error] 发送消息失败: ${result.description}`);
    } else {
      console.log("[telegram] 消息发送成功");
    }
    return result;
  } catch (error) {
    console.error(`[telegram-error] 发送消息时出错: ${error.message}`);
  }
}

// 转换成上海时间
function formatShanghaiTime(date) {
  const utcTime = date.getTime() + (date.getTimezoneOffset() * 60000);
  const shanghaiTime = new Date(utcTime + (8 * 60 * 60 * 1000));
  
  return shanghaiTime.getFullYear() + '-' + 
         String(shanghaiTime.getMonth() + 1).padStart(2, '0') + '-' + 
         String(shanghaiTime.getDate()).padStart(2, '0') + ' ' +
         String(shanghaiTime.getHours()).padStart(2, '0') + ':' +
         String(shanghaiTime.getMinutes()).padStart(2, '0');
}

// 根据URL识别区域
function detectRegionFromUrl(url) {
  for (const [regionCode, regionConfig] of Object.entries(REGIONS)) {
    if (regionConfig.DOMAIN_PATTERN.test(url)) {
      return regionCode;
    }
  }
  return null;
}

// CF API 交互函数
async function cfGET(url, token) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`CF GET ${response.status} ${url}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function cfPOST(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: payload ? JSON.stringify(payload) : null
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`CF POST ${response.status} ${url}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

// 认证函数
async function getUAAToken(email, password, uaaUrl) {
  try {
    console.log(`[auth] 尝试认证: ${email} @ ${uaaUrl}`);
    
    const authHeader = "Basic " + btoa("cf:");
    const body = new URLSearchParams();
    body.set("grant_type", "password");
    body.set("username", email);
    body.set("password", password);
    body.set("response_type", "token");

    const response = await fetch(`${uaaUrl}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: authHeader,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body
    });

    const text = await response.text();
    console.log(`[auth] 响应状态: ${response.status}, 响应文本: ${text.substring(0, 200)}...`);
    
    if (!response.ok) {
      throw new Error(`UAA token error: ${response.status} ${text}`);
    }
    
    const result = JSON.parse(text);
    return result.access_token;
  } catch (error) {
    console.error(`[auth-error] 认证失败: ${error.message}`);
    throw error;
  }
}

// 应用信息获取函数 
async function getAppGuidByName(apiUrl, token, appName) {
  const result = await cfGET(`${apiUrl}/v3/apps?names=${encodeURIComponent(appName)}`, token);
  if (result.resources && result.resources.length > 0) {
    return result.resources[0].guid;
  }
  throw new Error(`Application ${appName} not found`);
}

// 应用状态函数
async function getAppState(apiUrl, token, appGuid) {
  const result = await cfGET(`${apiUrl}/v3/apps/${appGuid}`, token);
  return result?.state || "UNKNOWN";
}

async function getWebProcessGuid(apiUrl, token, appGuid) {
  const result = await cfGET(`${apiUrl}/v3/apps/${appGuid}/processes`, token);
  const webProcess = result?.resources?.find(p => p?.type === "web") || result?.resources?.[0];
  if (!webProcess) {
    throw new Error("No web process found on app");
  }
  return webProcess.guid;
}

async function getProcessStats(apiUrl, token, processGuid) {
  return cfGET(`${apiUrl}/v3/processes/${processGuid}/stats`, token);
}

// 应用状态等待函数 
async function waitAppStarted(apiUrl, token, appGuid) {
  let delay = 2000;
  let state = "";
  
  for (let i = 0; i < 8; i++) {
    await sleep(delay);
    state = await getAppState(apiUrl, token, appGuid);
    console.log(`[app-state-check] attempt ${i + 1}: ${state}`);
    
    if (state === "STARTED") break;
    delay = Math.min(delay * 1.6, 15000);
  }
  
  if (state !== "STARTED") {
    throw new Error(`App not STARTED in time, final state=${state}`);
  }
}

async function waitProcessInstancesRunning(apiUrl, token, processGuid) {
  let delay = 2000;
  
  for (let i = 0; i < 10; i++) {
    const stats = await getProcessStats(apiUrl, token, processGuid);
    const instances = stats?.resources || [];
    const states = instances.map(it => it?.state);
    
    console.log(`[proc-stats] attempt ${i + 1}: ${states.join(",") || "no-instances"}`);
    
    if (states.some(s => s === "RUNNING")) return;
    
    await sleep(delay);
    delay = Math.min(delay * 1.6, 15000);
  }
  
  throw new Error("Process instances not RUNNING in time");
}

//  APP URL 检查函数 
async function checkAppUrl(appUrl) {
  try {
    const response = await fetch(appUrl, {
      method: "GET",
      signal: AbortSignal.timeout(30000)
    });
    console.log(`[app-check] ${appUrl} status: ${response.status}`);
    return response.status === 200;
  } catch (error) {
    console.log(`[app-check] ${appUrl} error: ${error.message}`);
    return false;
  }
}

// 首页
function generateStatusPage(apps) {
  // 获取当前时间并转换为上海时间（北京时间）
  const now = new Date();
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  const shanghaiTime = new Date(utcTime + (8 * 60 * 60 * 1000));
  
  const formattedDate = shanghaiTime.getFullYear() + '-' + 
                      String(shanghaiTime.getMonth() + 1).padStart(2, '0') + '-' + 
                      String(shanghaiTime.getDate()).padStart(2, '0') + ' ' +
                      String(shanghaiTime.getHours()).padStart(2, '0') + ':' +
                      String(shanghaiTime.getMinutes()).padStart(2, '0');
  
  const statusCards = apps.map(app => {
    const statusClass = app.healthy ? 'status-up' : 'status-down';
    const statusText = app.healthy ? '运行中' : '已停止';
    const regionName = app.region === 'US' ? '美国' : app.region === 'AP' ? '新加坡' : '未知';
    
    return `
      <div class="status-card ${statusClass}">
        <div class="card-header">
          <h3>${app.app}</h3>
          <span class="status-indicator ${statusClass}">${statusText}</span>
        </div>
        <div class="card-body">
          <p><strong>区域:</strong> ${regionName}</p>
          <p><strong>URL:</strong> <a href="${app.url}" target="_blank">${app.url}</a></p>
        </div>
      </div>
    `;
  }).join('');
  
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SAP Cloud 应用状态监控</title>
  <style>
    :root {
      --up-color: #4CAF50;
      --down-color: #F44336;
      --card-bg: #ffffff;
      --bg-color: #f5f5f5;
      --text-color: #333333;
      --border-radius: 8px;
      --box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      padding: 0;
      background-color: var(--bg-color);
      color: var(--text-color);
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      text-align: center; /* 添加居中对齐 */
    }
    
    header {
      text-align: center;
      padding: 30px 0;
      background: #667eea;
      color: white;
      border-radius: var(--border-radius);
      margin-bottom: 30px;
      box-shadow: var(--box-shadow);
    }
    
    h1 {
      margin: 0;
      font-size: 2.5rem;
    }
    
    .subtitle {
      font-size: 1.2rem;
      opacity: 0.9;
      margin-top: 10px;
    }
    
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 20px;
      margin: 0 auto; /* 居中网格容器 */
      max-width: 800px; /* 设置最大宽度 */
      width: 100%;
    }
    
    .status-card {
      background: var(--card-bg);
      border-radius: var(--border-radius);
      box-shadow: var(--box-shadow);
      overflow: hidden;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
      margin: 0 auto; /* 居中卡片 */
    }
    
    .status-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
    }
    
    .card-header {
      padding: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #eee;
    }
    
    .card-header h3 {
      margin: 0;
      font-size: 1.5rem;
    }
    
    .status-indicator {
      padding: 5px 15px;
      border-radius: 20px;
      font-weight: bold;
      font-size: 0.9rem;
    }
    
    .status-up {
      background-color: rgba(76, 175, 80, 0.1);
      color: var(--up-color);
    }
    
    .status-down {
      background-color: rgba(244, 67, 54, 0.1);
      color: var(--down-color);
    }
    
    .card-body {
      padding: 20px;
    }
    
    .card-body p {
      margin: 10px 0;
    }
    
    .card-body a {
      color: #1976D2;
      text-decoration: none;
    }
    
    .card-body a:hover {
      text-decoration: underline;
    }
    
    .last-updated {
      text-align: center;
      color: #666;
      font-size: 0.9rem;
      margin-top: 20px;
    }
    
    .controls {
      text-align: center;
      margin: 30px 0;
    }
    
    .btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 12px 24px;
      font-size: 1rem;
      border-radius: var(--border-radius);
      cursor: pointer;
      transition: opacity 0.3s ease;
    }
    
    .btn:hover {
      opacity: 0rais
    }
    
    footer {
      text-align: center;
      padding: 20px;
      color: #666;
      font-size: 0.9rem;
      border-top: 1px solid #eee;
      margin-top: 30px;
    }
    
    .footer-links {
      font-weight: 700;
      font-size: larger;
      margin-top: 10px;
    }
    
    .footer-links a {
      color: #1976D2;
      text-decoration: none;
      margin: 0 10px;
    }
    
    .footer-links a:hover {
      text-decoration: underline;
    }
    
    @media (max-width: 768px) {
      .status-grid {
        grid-template-columns: 1fr;
      }
      
      h1 {
        font-size: 2rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>SAP Cloud 应用监控</h1>
      <div class="subtitle">实时监控应用状态，确保服务持续可用</div>
    </header>
    
    <div class="controls">
      <button class="btn" onclick="refreshStatus()">刷新状态</button>
    </div>
    
    <div class="status-grid">
      ${statusCards}
    </div>
    
    <div class="last-updated">
      最后更新: ${formattedDate}
    </div>
    
    <footer>
      <p>SAP Cloud 多应用自动保活系统</p>
      <div class="footer-links">
        <a href="https://github.com/eooce/Auto-deploy-sap-and-keepalive" target="_blank">GitHub</a>
        <a href="https://www.youtube.com/@eooce" target="_blank">YouTube</a>
        <a href="https://t.me/eooceu" target="_blank">Telegram Group</a>
      </div>
      <p>&copy; ${new Date().getFullYear()} Auto-SAP. All rights reserved.</p>
    </footer>
  </div>
  
  <script>
    function refreshStatus() {
      location.reload();
    }
  </script>
</body>
</html>
  `;
}

// 核心启动逻辑
async function ensureAppRunning(appConfig, reason = "unknown") {
  const {url, name, region} = appConfig;
  
  console.log(`[trigger] ${reason} for app ${name} at ${new Date().toISOString()}`);
  
  // 第一步：检查应用URL状态
  const isAppHealthy = await checkAppUrl(url);
  if (isAppHealthy) {
    console.log(`[decision] ${url} 返回200，应用正常运行，无需启动`);
    return {app: name, status: "healthy", url: url};
  }
  
  // 发送离线提醒（使用上海时间）
  const now = new Date();
  const formattedTime = formatShanghaiTime(now);
  const offlineMessage = `⚠️ *SAP应用离线提醒*\n\n应用名称: ${name}\n应用URL: ${url}\n时间: ${formattedTime}\n\n正在尝试重启应用...`;
  await sendTelegramMessage(offlineMessage);
  
  console.log(`[decision] ${url} 状态异常，开始启动应用`);
  
  // 第二步：确定区域
  const detectedRegion = region || detectRegionFromUrl(url);
  if (!detectedRegion || !REGIONS[detectedRegion]) {
    throw new Error(`无法确定应用 ${name} 的区域，URL: ${url}`);
  }
  
  const regionConfig = REGIONS[detectedRegion];
  console.log(`[region] 应用 ${name} 的区域: ${detectedRegion}`);
  
  // 第三步：获取CF API访问令牌
  const token = await getUAAToken(email, password, regionConfig.UAA_URL);
  
  // 第四步：根据应用名称获取GUID
  const appGuid = await getAppGuidByName(regionConfig.CF_API, token, name);
  console.log(`[app-guid] ${appGuid}`);
  
  // 第五步：获取进程信息
  const processGuid = await getWebProcessGuid(regionConfig.CF_API, token, appGuid);
  
  // 第六步：检查当前应用状态
  const appState = await getAppState(regionConfig.CF_API, token, appGuid);
  console.log(`[app-state-before] ${appState}`);
  
  // 第七步：启动应用（如果需要）
  if (appState !== "STARTED") {
    await cfPOST(`${regionConfig.CF_API}/v3/apps/${appGuid}/actions/start`, token);
    console.log("[action] 应用启动请求已发送");
  }
  
  // 第八步：等待应用启动完成
  await waitAppStarted(regionConfig.CF_API, token, appGuid);
  await waitProcessInstancesRunning(regionConfig.CF_API, token, processGuid);
  
  // 第九步：再次检查应用URL确保启动成功
  console.log("[verification] 验证应用是否成功启动...");
  await sleep(5000);
  
  const isAppHealthyAfterStart = await checkAppUrl(url);
  if (isAppHealthyAfterStart) {
    console.log("[success] 应用启动成功，URL状态正常");
    // 发送重启成功提醒
    const successMessage = `✅ *SAP应用重启成功*\n\n应用名称: ${name}\n应用URL: ${url}\n时间: ${formatShanghaiTime(new Date())}`;
    await sendTelegramMessage(successMessage);
    return {app: name, status: "started", url: url};
  } else {
    // console.log("[warning] 应用启动完成但URL状态仍异常，可能需要更多时间");
    // 发送重启失败提醒
    const failedMessage = `❌ *应用重启失败*\n\n应用名称: ${name}\n应用URL: ${url}\n时间: ${formatShanghaiTime(new Date())}`;
    await sendTelegramMessage(failedMessage);
    return {app: name, status: "started_but_unhealthy", url: url};
  }
}

//监控所有应用
async function monitorAllApps(reason = "unknown") {
  console.log(`[monitor-start] 开始监控所有应用: ${reason}`);
  const results = [];
  
  for (const app of MONITORED_APPS) {
    try {
      const result = await ensureAppRunning(app, reason);
      results.push(result);
    } catch (error) {
      console.error(`[app-error] 处理应用 ${app.name} 时出错:`, error.message);
      results.push({app: app.name, status: "error", error: error.message, url: app.url});
    }
    // 在每个应用检查之间添加短暂延迟
    await sleep(1000);
  }
  
  console.log(`[monitor-complete] 所有应用监控完成`);
  return results;
}

export default {
  // HTTP 请求处理
  async fetch(request, env, ctx) {
    // 从环境变量获取邮箱和密码
      email = env.EMAIL || email;
      password = env.PASSWORD || password;
      CHAT_ID = env.CHAT_ID || CHAT_ID;
      BOT_TOKEN = env.BOT_TOKEN || BOT_TOKEN;
    
    // console.log(`[config] 使用邮箱: ${email}`);
    // console.log(`[config] 使用密码: ${password ? "已设置" : "未设置"}`);
    // console.log(`[config] 使用CHAT_ID: ${CHAT_ID ? "已设置" : "未设置"}`);
    // console.log(`[config] 使用BOT_TOKEN: ${BOT_TOKEN ? "已设置" : "未设置"}`);
    
    const url = new URL(request.url);
    
    try {
      // 根路径 - 显示前端页面
      if (url.pathname === "/") {
        // 获取所有应用状态
        const statusResults = [];
        for (const app of MONITORED_APPS) {
          const isHealthy = await checkAppUrl(app.url);
          statusResults.push({
            app: app.name,
            url: app.url,
            healthy: isHealthy,
            region: detectRegionFromUrl(app.url)
          });
        }
        
        // 生成HTML页面
        const html = generateStatusPage(statusResults);
        return new Response(html, {
          headers: { "content-type": "text/html;charset=UTF-8" }
        });
      }
      
      // 手动启动端点
      if (url.pathname === "/start") {
        ctx.waitUntil(monitorAllApps("manual").then(results => {
          console.log("手动启动结果:", results);
        }));
        return json({ ok: true, msg: "手动启动所有应用请求已触发" });
      }
      
      // 应用状态检查端点
      if (url.pathname === "/status") {
        const statusResults = [];
        
        for (const app of MONITORED_APPS) {
          const isHealthy = await checkAppUrl(app.url);
          statusResults.push({
            app: app.name,
            url: app.url,
            healthy: isHealthy,
            region: detectRegionFromUrl(app.url)
          });
        }
        
        return json({
          ok: true,
          apps: statusResults,
          timestamp: new Date().toISOString()
        });
      }
      
      // 诊断端点
      if (url.pathname === "/check") {
        return json({
          ok: true,
          monitoredApps: MONITORED_APPS,
          regions: Object.keys(REGIONS),
          timestamp: new Date().toISOString()
        });
      }
      
      // 默认响应
      return new Response("Cloud Foundry 多应用自动保活 Worker 运行中");
      
    } catch (error) {
      console.error("[error]", error?.message || error);
      return json({ ok: false, error: String(error) }, 500);
    }
  },

  // 定时任务处理
  async scheduled(event, env, ctx) {
    try {
      email = env.EMAIL || email;
      password = env.PASSWORD || password;
      
      // console.log(`[cron] 定时任务触发: ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
      // console.log(`[config] 使用邮箱: ${email}`);
      // console.log(`[config] 使用密码: ${password ? "已设置" : "未设置"}`);
      
      // 使用ctx.waitUntil确保定时任务完成
      ctx.waitUntil(monitorAllApps("cron").then(results => {
        console.log("定时任务结果:", results);
      }));
    } catch (error) {
      console.error("[cron-error]", error?.message || error);
    }
  }
};
