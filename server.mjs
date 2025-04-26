import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';

// --- 配置 ---
const pluginId = 'daily-usage-tracker';
const info = {
    id: 'daily-usage-tracker'
    name: '每日使用追踪器 (服务器)',
    description: '记录每日角色/群组聊天时长、消息数和字数 (北京时间)',
    version: '1.0.0'
};

// Day.js 配置北京时间
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);
dayjs.tz.setDefault("Asia/Shanghai");

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, 'data');
const CACHE_FLUSH_INTERVAL = 60 * 1000; // 每分钟刷写一次缓存

// --- 内存缓存与状态 ---
let dailyStatsCache = {}; // { 'YYYY-MM-DD': { entityId: { stats } } }
let cacheDirty = false;
let flushIntervalId = null;

// --- 辅助函数 ---

/** 获取当前北京日期的 YYYY-MM-DD 字符串 */
function getBeijingDateString() {
    return dayjs().tz("Asia/Shanghai").format('YYYY-MM-DD');
}

/** 获取指定日期的数据文件路径 */
function getStatsFilePath(dateString) {
    return path.join(dataDir, `${dateString}.json`);
}

/**
 * 加载或获取指定日期的统计数据。
 * 会先尝试从内存缓存读取，若无则从文件加载。
 * @param {string} dateString 'YYYY-MM-DD' 格式
 * @returns {Promise<object>} 该日期的统计数据对象，可能为空对象 {}
 */
async function loadOrGetStatsForDate(dateString) {
    if (dailyStatsCache[dateString]) {
        return dailyStatsCache[dateString];
    }

    const filePath = getStatsFilePath(dateString);
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const stats = JSON.parse(fileContent);
        dailyStatsCache[dateString] = stats; // 加载到缓存
        console.log(`[${info.name}] Loaded stats for ${dateString} from file.`);
        return stats;
    } catch (error) {
        if (error.code === 'ENOENT') {
            // 文件不存在，是正常的，返回空对象
            console.log(`[${info.name}] No stats file found for ${dateString}, starting fresh.`);
            dailyStatsCache[dateString] = {}; // 初始化缓存
            return {};
        } else {
            console.error(`[${info.name}] Error reading stats file ${filePath}:`, error);
            return {}; // 出错时返回空对象，避免阻塞
        }
    }
}

/**
 * 将脏缓存写入对应的 JSON 文件。
 * @param {boolean} force - 是否强制写入所有日期的缓存（即使没标记为 dirty）
 */
async function flushCacheToDisk(force = false) {
    if (!cacheDirty && !force) {
        return;
    }

    console.log(`[${info.name}] Flushing cache to disk (Force: ${force})...`);
    const datesToFlush = force ? Object.keys(dailyStatsCache) : (cacheDirty ? [getBeijingDateString()] : []); // 强制模式下刷所有，否则只刷当天

    let successCount = 0;
    let errorCount = 0;

    for (const dateString of datesToFlush) {
        if (!dailyStatsCache[dateString]) continue; // 跳过不存在的数据

        const filePath = getStatsFilePath(dateString);
        const dataToWrite = JSON.stringify(dailyStatsCache[dateString], null, 2); // 美化 JSON 输出

        try {
            await fs.mkdir(dataDir, { recursive: true }); // 确保目录存在
            await fs.writeFile(filePath, dataToWrite, 'utf8');
            successCount++;
        } catch (error) {
            errorCount++;
            console.error(`[${info.name}] Error writing stats file ${filePath}:`, error);
        }
    }

    if (successCount > 0) {
       console.log(`[${info.name}] Successfully flushed cache for ${successCount} dates.`);
    }
    if (errorCount > 0) {
        console.error(`[${info.name}] Failed to flush cache for ${errorCount} dates.`);
    }


    cacheDirty = false; // 重置脏标记（即使强制模式也重置，因为已经写入了）
}

// --- 插件生命周期 ---

/**
 * 初始化函数 (必需)
 * @param {import('express').Router} router - Express 路由器实例
 * @returns {Promise<void>}
 */
async function init(router) {
    console.log(`[${info.name}] v${info.version} Initializing...`);

    // 确保数据目录存在
    try {
        await fs.mkdir(dataDir, { recursive: true });
        console.log(`[${info.name}] Data directory ensured: ${dataDir}`);
    } catch (error) {
        console.error(`[${info.name}] Failed to create data directory:`, error);
        return Promise.reject(new Error('Failed to create data directory')); // 初始化失败
    }

    // 启动定时刷写缓存任务
    flushIntervalId = setInterval(() => flushCacheToDisk(false), CACHE_FLUSH_INTERVAL);
    console.log(`[${info.name}] Cache flush interval set to ${CACHE_FLUSH_INTERVAL / 1000} seconds.`);

    // 使用 express.json() 中间件解析 JSON 请求体
    // 增加 limit 以防数据量稍大
    router.use(express.json({ limit: '1mb' }));

    // --- API 路由 ---

    // POST /api/plugins/daily-usage-tracker/track
    // 接收前端发送的增量追踪数据
    router.post('/track', async (req, res) => {
        const { entityId, timeIncrementMs, messageIncrement, wordIncrement, isUser } = req.body;

        // 基本验证
        if (!entityId) {
            return res.status(400).json({ error: 'Missing entityId' });
        }
        if (timeIncrementMs === undefined && messageIncrement === undefined) {
             return res.status(400).json({ error: 'No tracking data provided (time or message)' });
        }

        try {
            const dateString = getBeijingDateString();
            const dailyStats = await loadOrGetStatsForDate(dateString);

            // 初始化该实体的统计对象（如果当天首次出现）
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

            // 累加数据
            if (typeof timeIncrementMs === 'number' && timeIncrementMs > 0) {
                entityStats.totalTimeMs += timeIncrementMs;
            }
            if (typeof messageIncrement === 'number' && messageIncrement > 0) {
                if (isUser) {
                    entityStats.userMsgCount += messageIncrement;
                    if (typeof wordIncrement === 'number' && wordIncrement >= 0) {
                        entityStats.userWordCount += wordIncrement;
                    }
                } else {
                    entityStats.aiMsgCount += messageIncrement;
                    if (typeof wordIncrement === 'number' && wordIncrement >= 0) {
                        entityStats.aiWordCount += wordIncrement;
                    }
                }
            }

            cacheDirty = true; // 标记缓存已更改
            // console.debug(`[${info.name}] Tracked data for ${entityId} on ${dateString}:`, req.body); // 调试日志
            res.status(200).json({ success: true });

        } catch (error) {
            console.error(`[${info.name}] Error processing /track request:`, error);
            res.status(500).json({ error: 'Internal server error while tracking data' });
        }
    });

    // GET /api/plugins/daily-usage-tracker/stats?date=YYYY-MM-DD
    // 获取指定日期的统计数据
    router.get('/stats', async (req, res) => {
        let dateString = req.query.date;

        // 如果没有提供日期，则默认为当天北京日期
        if (!dateString) {
            dateString = getBeijingDateString();
        } else {
            // 验证日期格式
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
                return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
            }
            // 验证是否是未来日期 (基于北京时间)
            const requestedDate = dayjs(dateString).tz("Asia/Shanghai");
            const today = dayjs().tz("Asia/Shanghai").endOf('day'); // 今天结束时间
            if (requestedDate.isAfter(today)) {
                return res.status(400).json({ error: 'Cannot request stats for a future date.' });
            }
        }

        try {
            // 先尝试强制刷写当天缓存，确保文件是最新的（如果用户在查询前刚操作过）
            if(dateString === getBeijingDateString()){
                await flushCacheToDisk(false); // 只刷写当天的脏缓存
            }

            // 从缓存或文件加载数据
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

/**
 * 退出函数 (可选)
 * @returns {Promise<void>}
 */
async function exit() {
    console.log(`[${info.name}] Exiting...`);
    if (flushIntervalId) {
        clearInterval(flushIntervalId);
        console.log(`[${info.name}] Cache flush interval cleared.`);
    }
    // 在退出前强制刷写所有脏缓存
    try {
        await flushCacheToDisk(true); // 强制写入所有缓存
        console.log(`[${info.name}] Final cache flush complete.`);
    } catch (error) {
        console.error(`[${info.name}] Error during final cache flush:`, error);
        return Promise.reject(error); // 退出失败
    }
    console.log(`[${info.name}] Exit complete.`);
    return Promise.resolve(); // 退出成功
}

// 导出必需的部分
export { info, init, exit };
