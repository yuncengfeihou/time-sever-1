// SillyTavern 服务器插件 - 每日使用统计
const fs = require('fs/promises');
const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

// 配置 dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Shanghai'); // 设置默认时区为北京时间

// 插件信息
const info = {
    id: 'daily-usage-tracker',
    name: '每日使用统计',
    description: '统计用户每天与不同角色/群组的交互数据'
};

// 配置
const DATA_DIR = path.join(process.cwd(), 'public', 'assets', 'daily-usage-data');
const CACHE_FLUSH_INTERVAL = 60 * 1000; // 1分钟

// 内存缓存
let dailyStatsCache = {};
let cacheDirty = false;
let flushInterval = null;

// 获取北京日期字符串 (YYYY-MM-DD)
function getBeijingDateString() {
    return dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

// 获取统计数据文件路径
function getStatsFilePath(dateString) {
    return path.join(DATA_DIR, `${dateString}.json`);
}

// 从缓存或文件加载特定日期的统计数据
async function loadOrGetStatsForDate(dateString) {
    // 如果已在缓存中，直接返回
    if (dailyStatsCache[dateString]) {
        return dailyStatsCache[dateString];
    }

    // 尝试从文件加载
    try {
        const filePath = getStatsFilePath(dateString);
        const fileData = await fs.readFile(filePath, 'utf8');
        dailyStatsCache[dateString] = JSON.parse(fileData);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // 文件不存在，创建新的空对象
            dailyStatsCache[dateString] = {};
        } else {
            console.error(`[${info.name}] 读取统计数据文件失败:`, error);
            // 发生错误时也创建空对象
            dailyStatsCache[dateString] = {};
        }
    }

    return dailyStatsCache[dateString];
}

// 将缓存刷写到磁盘
async function flushCacheToDisk(force = false) {
    if (!cacheDirty && !force) return;

    // 确保数据目录存在
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (error) {
        console.error(`[${info.name}] 创建数据目录失败:`, error);
        return;
    }

    // 保存每个日期的数据到对应文件
    const savePromises = Object.keys(dailyStatsCache).map(async (dateString) => {
        const stats = dailyStatsCache[dateString];
        const filePath = getStatsFilePath(dateString);
        
        try {
            await fs.writeFile(filePath, JSON.stringify(stats, null, 2), 'utf8');
            console.log(`[${info.name}] 已保存统计数据: ${dateString}`);
        } catch (error) {
            console.error(`[${info.name}] 保存统计数据失败 ${dateString}:`, error);
        }
    });

    await Promise.all(savePromises);
    cacheDirty = false;
}

// 初始化函数
async function init(router) {
    console.log(`[${info.name}] 初始化中...`);

    // 确保数据目录存在
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (error) {
        console.error(`[${info.name}] 创建数据目录失败:`, error);
    }

    // 设置定时保存缓存
    flushInterval = setInterval(flushCacheToDisk, CACHE_FLUSH_INTERVAL);

    // 使用Express中间件解析JSON请求体
    const express = require('express');
    router.use(express.json({ limit: '1mb' }));

    // 跟踪API - 接收前端发送的数据增量
    router.post('/track', async (req, res) => {
        try {
            const { entityId, timeIncrementMs, messageIncrement, wordIncrement, isUser } = req.body;

            if (!entityId) {
                return res.status(400).json({ error: '缺少必要参数 entityId' });
            }

            // 获取当前北京日期
            const dateString = getBeijingDateString();
            
            // 加载或获取当天的统计数据
            const stats = await loadOrGetStatsForDate(dateString);
            
            // 如果实体不存在，初始化其数据
            if (!stats[entityId]) {
                stats[entityId] = {
                    totalTimeMs: 0,
                    userMsgCount: 0,
                    aiMsgCount: 0,
                    userWordCount: 0,
                    aiWordCount: 0
                };
            }

            // 更新活跃时间（如果提供）
            if (timeIncrementMs && timeIncrementMs > 0) {
                stats[entityId].totalTimeMs += timeIncrementMs;
            }

            // 更新消息计数（如果提供）
            if (messageIncrement && messageIncrement > 0) {
                if (isUser) {
                    stats[entityId].userMsgCount += messageIncrement;
                } else {
                    stats[entityId].aiMsgCount += messageIncrement;
                }
            }

            // 更新字数计数（如果提供）
            if (wordIncrement && wordIncrement > 0) {
                if (isUser) {
                    stats[entityId].userWordCount += wordIncrement;
                } else {
                    stats[entityId].aiWordCount += wordIncrement;
                }
            }

            // 标记缓存为脏
            cacheDirty = true;

            res.status(200).json({ success: true });
        } catch (error) {
            console.error(`[${info.name}] 处理跟踪数据失败:`, error);
            res.status(500).json({ error: '处理跟踪数据失败' });
        }
    });

    // 统计API - 获取特定日期的统计数据
    router.get('/stats', async (req, res) => {
        try {
            // 获取查询参数中的日期，默认为当天
            const dateString = req.query.date || getBeijingDateString();
            
            // 验证日期格式 (简单检查)
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
                return res.status(400).json({ error: '无效的日期格式，应为 YYYY-MM-DD' });
            }

            // 检查是否为未来日期
            if (dayjs(dateString).isAfter(dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD'))) {
                return res.status(400).json({ error: '不能查询未来日期的统计数据' });
            }

            // 加载统计数据
            const stats = await loadOrGetStatsForDate(dateString);
            res.status(200).json(stats);
        } catch (error) {
            console.error(`[${info.name}] 获取统计数据失败:`, error);
            res.status(500).json({ error: '获取统计数据失败' });
        }
    });

    console.log(`[${info.name}] 初始化完成`);
    return Promise.resolve();
}

// 退出函数
async function exit() {
    console.log(`[${info.name}] 正在退出...`);
    
    // 清除定时器
    if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
    }

    // 强制刷写缓存
    await flushCacheToDisk(true);
    
    console.log(`[${info.name}] 退出完成`);
    return Promise.resolve();
}

module.exports = {
    info,
    init,
    exit
};
