// SillyTavern/plugins/daily-usage-tracker/time-sever-1.mjs
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js'; // 导入 UTC 插件
import timezone from 'dayjs/plugin/timezone.js'; // 导入时区插件

// 配置 Dayjs 使用 UTC 和时区插件
dayjs.extend(utc);
dayjs.extend(timezone);

// --- 配置 ---
const pluginId = 'daily-usage-tracker';
const dataDirName = 'daily-usage-data'; // 存储数据的子目录名
const dataDir = path.join(process.cwd(), 'plugins', pluginId, dataDirName); // 数据存储目录完整路径
const CACHE_FLUSH_INTERVAL = 30 * 1000; // 30 秒刷写一次缓存到磁盘
const BEIJING_TIMEZONE = "Asia/Shanghai"; // 北京时间时区

// --- 内存缓存 ---
let dailyStatsCache = {}; // { 'YYYY-MM-DD': { 'entityId': { stats... } } }
let cacheDirty = false; // 缓存是否需要写入磁盘
let flushIntervalId = null; // 定时器 ID

// --- 插件信息 ---
const info = {
    id: pluginId,
    name: 'Daily Usage Tracker Server',
    description: 'Tracks daily chat time, messages, and words per character/group (Beijing Time).',
};

// --- 辅助函数 ---

/**
 * 获取当前北京时间的日期字符串 (YYYY-MM-DD)
 * @returns {string}
 */
function getBeijingDateString() {
    return dayjs().tz(BEIJING_TIMEZONE).format('YYYY-MM-DD');
}

/**
 * 获取指定日期的数据文件路径
 * @param {string} dateString YYYY-MM-DD
 * @returns {string}
 */
function getStatsFilePath(dateString) {
    return path.join(dataDir, `${dateString}.json`);
}

/**
 * 确保数据目录存在
 */
async function ensureDataDirExists() {
    try {
        await fs.mkdir(dataDir, { recursive: true });
    } catch (error) {
        console.error(`[${info.name}] Error creating data directory ${dataDir}:`, error);
        throw error; // 抛出错误，阻止插件继续初始化
    }
}

/**
 * 从缓存或文件加载指定日期的数据
 * @param {string} dateString YYYY-MM-DD
 * @returns {Promise<object>} 该日期的数据对象，格式：{ 'entityId': { stats... } }
 */
async function loadOrGetStatsForDate(dateString) {
    // 优先从缓存读取
    if (dailyStatsCache[dateString]) {
        return dailyStatsCache[dateString];
    }

    // 缓存未命中，尝试从文件加载
    const filePath = getStatsFilePath(dateString);
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const stats = JSON.parse(fileContent);
        // 加载到缓存
        dailyStatsCache[dateString] = stats;
        return stats;
    } catch (error) {
        // 文件不存在或读取错误，返回空对象
        if (error.code === 'ENOENT') {
            console.log(`[${info.name}] No data file found for ${dateString}, starting fresh.`);
        } else {
            console.error(`[${info.name}] Error reading stats file ${filePath}:`, error);
        }
        // 初始化缓存
        dailyStatsCache[dateString] = {};
        return dailyStatsCache[dateString];
    }
}

/**
 * 将脏缓存（如果存在）写入对应的 JSON 文件
 * @param {boolean} force - 是否强制写入，即使缓存不脏 (用于退出时)
 */
async function flushCacheToDisk(force = false) {
    if (!cacheDirty && !force) {
        return; // 缓存没变，且非强制，则不写入
    }

    const dirtyDates = Object.keys(dailyStatsCache);
    if (dirtyDates.length === 0 && !force) {
        return;
    }

    console.log(`[${info.name}] Flushing cache to disk (Force: ${force}, Dirty: ${cacheDirty})`);
    cacheDirty = false; // 先标记为干净，如果在写入过程中又有新数据，下次循环会处理

    for (const dateString of dirtyDates) {
        const filePath = getStatsFilePath(dateString);
        const dataToWrite = dailyStatsCache[dateString];
        // 只写入今天或之前的数据，防止意外写入未来数据（理论上不该发生）
        if (dataToWrite && dayjs(dateString, 'YYYY-MM-DD').isSameOrBefore(dayjs().tz(BEIJING_TIMEZONE), 'day')) {
            try {
                await fs.writeFile(filePath, JSON.stringify(dataToWrite, null, 2), 'utf8'); // 使用 null, 2 美化输出 JSON
                // console.log(`[${info.name}] Successfully wrote data for ${dateString} to ${filePath}`);
            } catch (error) {
                console.error(`[${info.name}] Error writing stats file ${filePath}:`, error);
                cacheDirty = true; // 写入失败，标记回 dirty，下次重试
            }
        }
    }
}

// --- 初始化函数 ---
async function init(router) {
    console.log(`[${info.name}] Initializing...`);

    try {
        await ensureDataDirExists(); // 确保数据目录存在
    } catch (error) {
        console.error(`[${info.name}] Failed to ensure data directory exists. Plugin will not function correctly.`);
        return Promise.reject(new Error("Failed to create data directory")); // 初始化失败
    }

    // 启动定时刷写缓存任务
    if (flushIntervalId) clearInterval(flushIntervalId); // 清除旧的定时器（如果存在）
    flushIntervalId = setInterval(() => flushCacheToDisk(false), CACHE_FLUSH_INTERVAL);
    console.log(`[${info.name}] Cache flush interval set to ${CACHE_FLUSH_INTERVAL / 1000} seconds.`);

    // 使用 Express 内置的 JSON 解析中间件，限制请求体大小
    router.use(express.json({ limit: '1mb' }));

    // --- API 路由 ---

    // POST /api/plugins/daily-usage-tracker/track
    // 用于接收前端发送的增量数据
    router.post('/track', async (req, res) => {
        const { entityId, timeIncrementMs, messageIncrement, wordIncrement, isUser } = req.body;

        // 基本的输入验证
        if (!entityId) {
            return res.status(400).json({ error: 'Missing entityId' });
        }
        if (timeIncrementMs == null && messageIncrement == null) {
             return res.status(400).json({ error: 'At least timeIncrementMs or messageIncrement must be provided' });
        }
         if (messageIncrement != null && typeof isUser !== 'boolean') {
             return res.status(400).json({ error: 'isUser (boolean) is required when messageIncrement is provided' });
         }

        try {
            const dateString = getBeijingDateString(); // 获取当前北京日期
            const dailyStats = await loadOrGetStatsForDate(dateString);

            // 初始化该实体的统计对象（如果不存在）
            if (!dailyStats[entityId]) {
                dailyStats[entityId] = {
                    totalTimeMs: 0,
                    userMsgCount: 0,
                    aiMsgCount: 0,
                    userWordCount: 0,
                    aiWordCount: 0,
                };
            }

            const entityStats = dailyStats[entityId];

            // 累加时间
            if (typeof timeIncrementMs === 'number' && timeIncrementMs > 0) {
                entityStats.totalTimeMs += timeIncrementMs;
            }

            // 累加消息数和字数
            if (typeof messageIncrement === 'number' && messageIncrement > 0) {
                const words = typeof wordIncrement === 'number' && wordIncrement >= 0 ? wordIncrement : 0;
                if (isUser) {
                    entityStats.userMsgCount += messageIncrement;
                    entityStats.userWordCount += words;
                } else {
                    entityStats.aiMsgCount += messageIncrement;
                    entityStats.aiWordCount += words;
                }
            }

            // 标记缓存已更改
            cacheDirty = true;

            res.status(200).json({ success: true });
        } catch (error) {
            console.error(`[${info.name}] Error processing /track request:`, error);
            res.status(500).json({ error: 'Internal server error while tracking usage' });
        }
    });

    // GET /api/plugins/daily-usage-tracker/stats?date=YYYY-MM-DD
    // 用于前端获取指定日期的统计数据
    router.get('/stats', async (req, res) => {
        const requestedDate = req.query.date;
        let dateString;

        if (requestedDate && dayjs(requestedDate, 'YYYY-MM-DD', true).isValid()) {
             // 验证日期格式是否有效且严格匹配 YYYY-MM-DD
            dateString = requestedDate;
        } else {
            // 如果没有提供日期或格式无效，则默认为当天北京日期
            dateString = getBeijingDateString();
            if (requestedDate) {
                 console.warn(`[${info.name}] Invalid date format received: ${requestedDate}. Defaulting to today (${dateString}).`);
            }
        }

        // （可选）阻止查询未来日期的数据
        if (dayjs(dateString, 'YYYY-MM-DD').isAfter(dayjs().tz(BEIJING_TIMEZONE), 'day')) {
             console.warn(`[${info.name}] Attempted to query future date: ${dateString}. Returning empty data.`);
             return res.status(200).json({}); // 或者返回 400 Bad Request
        }


        try {
            const stats = await loadOrGetStatsForDate(dateString);
            res.status(200).json(stats);
        } catch (error) {
            console.error(`[${info.name}] Error processing /stats request for date ${dateString}:`, error);
            res.status(500).json({ error: `Internal server error while fetching stats for ${dateString}` });
        }
    });

    console.log(`[${info.name}] Initialization complete. API endpoints registered.`);
    return Promise.resolve(); // 初始化成功
}

// --- 退出函数 ---
async function exit() {
    console.log(`[${info.name}] Exiting...`);
    if (flushIntervalId) {
        clearInterval(flushIntervalId); // 停止定时器
        flushIntervalId = null;
    }
    // 在退出前强制将所有缓存写入磁盘
    await flushCacheToDisk(true);
    console.log(`[${info.name}] Final cache flushed. Exit complete.`);
    return Promise.resolve(); // 退出成功
}

// --- 导出 ---
export {
    info,
    init,
    exit
};
