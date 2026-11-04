const {redis, 
    closeRedis
} = require("../backend/redis/redisClient");

async function main() {
    try {
        await redis.set("test.message", "Hello Redis!");
        const result = await redis.get('test.message');

        console.log("redis tra ve ", result);
    } finally{
        await closeRedis();
    }
}

main().catch((error) => {
    console.error (error);
    process.exitCode = 1;
});