
'use strict';

// Phát sự kiện tới một client
async function publishToClient(manager, targetClientId, msgString) {
  if (!manager.isConnected || !manager.pubClient) {
    return false;
  }

  try {
    await manager.pubClient.publish(
      `chat:client:${targetClientId}`,
      msgString
    );

    return true;
  } catch (error) {
    console.error('[Redis PubSub] publishToClient:', error.message);
    return false;
  }
}

// Phát sự kiện ghép cặp
async function publishMatchEvent(manager, matchData) {
  if (!manager.isConnected || !manager.pubClient) {
    return false;
  }

  try {
    await manager.pubClient.publish(
      'chat:{match}:room:match',
      JSON.stringify(matchData)
    );

    return true;
  } catch (error) {
    console.error('[Redis PubSub] publishMatchEvent:', error.message);
    return false;
  }
}

// Phát sự kiện rời phòng
async function publishRoomLeft(manager, clientId, partnerId, reason = null) {
  if (!manager.isConnected || !manager.pubClient) {
    return false;
  }

  try {
    await manager.pubClient.publish(
      'chat:{match}:room:left',
      JSON.stringify({
        clientId,
        partnerId,
        reason,
        sourceInstanceId: manager.instanceId
      })
    );

    return true;
  } catch (error) {
    console.error('[Redis PubSub] publishRoomLeft:', error.message);
    return false;
  }
}


function setupSubscriptions(manager) {
  if (!manager.subClient) return;

  const subClient = manager.subClient;

  // Đăng ký các kênh Pub/Sub
  subClient.psubscribe(
    'chat:client:*',
    'chat:{match}:room:*',
    'chat:system:*',
    (error) => {
      if (error) {
        manager.subReady = false;
        manager.isConnected = false;

        console.error(
          '[Redis] Lỗi đăng ký Pub/Sub:',
          error.message
        );

        return;
      }

      manager.subReady = true;
      manager.isConnected =
        manager.pubReady && manager.subReady;

      console.log(
        '[Redis] Đã đăng ký lắng nghe Pub/Sub'
      );
    }
  );

  // Chỉ đăng ký listener một lần
  if (manager._subscriptionsRegistered) return;

  manager._subscriptionsRegistered = true;

  subClient.on('pmessage', (pattern, channel, message) => {
    try {
      if (channel.startsWith('chat:client:')) {
        const targetClientId =
          channel.replace('chat:client:', '');

        manager.onDirectMessage(targetClientId, message);

      } else if (channel === 'chat:{match}:room:match') {
        const data = JSON.parse(message);
        manager.onMatchEvent(data);

      } else if (channel === 'chat:{match}:room:left') {
        const data = JSON.parse(message);
        manager.onRoomLeft(data);

      } else if (channel === 'chat:system:online') {
        const data = JSON.parse(message);
        manager.onOnlineCount(data.count);
      }

    } catch (error) {
      console.error(
        '[Redis] Lỗi xử lý pmessage:',
        error.message
      );
    }
  });
}


module.exports = {
  publishToClient,
  publishMatchEvent,
  publishRoomLeft,
  setupSubscriptions
};
