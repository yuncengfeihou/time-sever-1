import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// --- 配置 ---
const pluginId = 'daily-usage-tracker'; // *** 必须与前端使用的 ID 一致 ***
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const writeInterval = 5 * 60 * 1000; // 5 分钟写入一次磁盘 (毫秒)

// --- 内存缓存 ---
let dailyStatsCache = {}; // { [dateString]: { [charId]: { stats... } } }
let dirtyDates = new Set(); // 记录哪些日期的缓存已被修改，需要写入磁盘
let writeIntervalId = null;

// --- 辅助函数 ---

function getBeijingDateString() {
    const now = new Date();
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const year = beijingTime.getUTCFullYear();
    const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getStatsFilePath(dateString) {
    return path.join(dataDir, `${dateString}.json`);
}

async function loadStatsForDate(dateString) {
    // 优先从缓存读取
    if (dailyStatsCache[dateString]) {
        return dailyStatsCache[dateString];
    }
    // 缓存未命中，尝试从文件加载
    const filePath = getStatsFilePath(dateString);
    try {
        await fs.mkdir(dataDir, { recursive: true });
        const data = await fs.readFile(filePath, 'utf-8');
        const stats = JSON.parse(data);
        dailyStatsCache[dateString] = stats; // 加载到缓存
        console.log(`Stats loaded from file for ${dateString}`);
        return stats;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`Stats file for ${dateString} not found, initializing cache.`);
            dailyStatsCache[dateString] = {}; // 初始化空缓存
            return dailyStatsCache[dateString];
        }
        console.error(`Error loading stats file for ${dateString}:`, error);
        // 即使加载失败也返回空对象，避免 /stats 接口出错
        dailyStatsCache[dateString] = {};
        return dailyStatsCache[dateString];
    }
}

async function saveStatsToFile(dateString, statsData) {
    const filePath = getStatsFilePath(dateString);
    try {
        await fs.writeFile(filePath, JSON.stringify(statsData, null, 2), 'utf-8');
        console.log(`Stats saved to file for ${dateString}`);
    } catch (error) {
        console.error(`Error saving stats file for ${dateString}:`, error);
        // 保存失败也需要考虑如何处理，是否重试等
    }
}

/**
 * 将内存中标记为 dirty 的日期的统计数据写入磁盘
 */
async function saveDirtyCacheToDisk() {
    if (dirtyDates.size === 0) {
        // console.log("Cache is clean, skipping disk write.");
        return;
    }

    console.log(`Saving dirty cache to disk for dates: ${[...dirtyDates].join(', ')}`);
    const datesToSave = [...dirtyDates]; // 复制一份，防止在异步写入时集合被修改
    dirtyDates.clear(); // 标记为干净，即使写入失败下次也会重试

    const savePromises = datesToSave.map(dateString => {
        if (dailyStatsCache[dateString]) { // 确保缓存存在
            return saveStatsToFile(dateString, dailyStatsCache[dateString]);
        }
        return Promise.resolve(); // 如果缓存不存在，忽略
    });

    try {
        await Promise.all(savePromises);
        console.log("Dirty cache saved successfully.");
    } catch (error) {
        console.error("Error during saving dirty cache:", error);
        // 写入失败，将日期重新标记为 dirty，以便下次尝试
        datesToSave.forEach(date => dirtyDates.add(date));
    }
}

// --- 插件主体 ---

async function init(router) {
    console.log(`${info.name} (ID: ${info.id}) initializing...`);
    await fs.mkdir(dataDir, { recursive: true });

    // 预加载当天的统计数据（可选，但推荐）
    const todayString = getBeijingDateString();
    await loadStatsForDate(todayString);

    // 启动定时写入磁盘
    writeIntervalId = setInterval(saveDirtyCacheToDisk, writeInterval);
    console.log(`Periodic cache saving started (interval: ${writeInterval / 1000}s).`);

    // API 端点：接收前端发送的 *累积* 数据
    router.post('/track', async (req, res) => {
        try {
            const { characterId, timeMs = 0, msgInc = 0, wordInc = 0 } = req.body; // 接收累积值

            if (!characterId) {
                return res.status(400).json({ error: 'Missing characterId' });
            }

            const dateString = getBeijingDateString();

            // 确保当天的缓存存在 (如果插件刚启动可能需要加载)
            if (!dailyStatsCache[dateString]) {
                await loadStatsForDate(dateString);
            }
            const stats = dailyStatsCache[dateString]; // 直接操作内存缓存

            if (!stats[characterId]) {
                stats[characterId] = { totalTimeMs: 0, messageCount: 0, wordCount: 0 };
            }

            // 累加数据
            stats[characterId].totalTimeMs += Number(timeMs) || 0;
            stats[characterId].messageCount += Number(msgInc) || 0;
            stats[characterId].wordCount += Number(wordInc) || 0;

            // 标记此日期为 dirty
            dirtyDates.add(dateString);

            // **不写入磁盘，只更新内存**
            // console.log(`Cache updated for ${dateString}, char ${characterId}`); // 日志可能过多

            res.status(200).json({ success: true }); // 立即响应
        } catch (error) {
            console.error('Error handling /track request:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // API 端点：获取指定日期的统计数据
    router.get('/stats', async (req, res) => {
        try {
            let dateString = req.query.date;

            if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
                dateString = getBeijingDateString();
            }

            // 尝试从缓存加载，如果失败则从文件加载
            const stats = await loadStatsForDate(dateString);
            res.status(200).json(stats);
        } catch (error) {
            console.error('Error handling /stats request:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    console.log(`${info.name} initialized successfully.`);
    return Promise.resolve();
}

async function exit() {
    console.log(`${info.name} exiting...`);
    if (writeIntervalId) {
        clearInterval(writeIntervalId);
        console.log("Periodic cache saving stopped.");
    }
    // 在退出前执行最后一次保存
    await saveDirtyCacheToDisk();
    console.log("Final cache saved on exit.");
    return Promise.resolve();
}

const info = {
    id: pluginId,
    name: '聊天统计插件 (优化版)',
    description: '统计每日聊天数据，优化了写入性能。',
};

export { init, exit, info };

// // --- CommonJS 导出 (如果使用 .js) ---
// module.exports = { init, exit, info };
