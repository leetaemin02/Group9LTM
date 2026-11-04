const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

//redis dung doc va ghi du lieu

const redis = new Redis(REDIS_URL, {
  // Không giữ lệnh trong hàng đợi khi Redis chưa sẵn sàng
  enableOfflineQueue: false,

  // Giới hạn retry cho lệnh đang chờ
  maxRetriesPerRequest: 1,

  // Thời gian tối đa thiết lập kết nối
  connectTimeout: 2000,

  // Thời gian tối đa chờ phản hồi một lệnh
  commandTimeout: 2000,

  // Tự kết nối lại khi Redis bị ngắt
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);

    console.log(
      `[Redis] Thử kết nối lại lần ${times}, sau ${delay}ms`
    );

    return delay;
  }
});


//redis dung publish ghi su kien
const publisher = new Redis(REDIS_URL);

//redis dung subscribe su kien
const subscriber = new Redis(REDIS_URL);

const clients = {
    redis,
    publisher,
    subscriber
};

for (const [name, client] of Object.entries(clients)) {
    client.on ('ready',()=>{
        console.log(`[Redis] ${name} connected`);
    });

    client.on('error',(err)=>{
        console.error(`[Redis] ${name}: `, err.message );
    });
}

async function closeRedis() {
    await Promise.all(
        Object.values(clients).map((client) => client.quit())
    );
}

module.exports = {
    redis,
    publisher,
    subscriber,
    closeRedis
};