const http = require("http");
const WebSocket = require("ws");

// Render canlılık kontrolü ve port dinleme sunucusu
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("NT_bot is online and running 24/7!");
}).listen(PORT, () => {
    console.log(`[+] Web server is listening on port ${PORT}`);
});

// --- TEMEL BİLGİLER VE YAPILANDIRMA ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error("[ERROR] BOT_TOKEN environment variable is not defined!");
    process.exit(1);
}

const BOT_ID = "01M47AGAT9V8YAV47WKZ6T75HW";
const SERVER_ID = "01M4770PV7XE8MX50AJ4TF5ZFX";

// 1. Sistem: Otomatik Üye Rolü
const MEMBER_ROLE_ID = "01M477JFKZT7V5ETD64WDFXWFH";
const MEMBER_WELCOME_MSG_ID = "01M47D6P984BD4QJCBGD9QESYX";

// 2. Sistem: Manuel Onaylı Crew Başvurusu
const CREW_CHANNEL_ID = "01M47EHNH4XF7ANGYC5KD2MRJD";
const CREW_ADMIN_CHANNEL_ID = "01M4770PV782SAJ273F1WRSX5Z";
const CREW_ROLE_ID = "01M477SDP4DQCF4DWBH3A29JBR";
const CREW_EMOJI = "🎯";
const CREW_MESSAGE_ID = "01M47EQABGMNDM49W8JRFJ6HR0";

// Spam engeli: 1 saatlik cooldown süresi
const CREW_COOLDOWN_MS = 60 * 60 * 1000;
const crewCooldowns = new Map(); // Kullanıcı ID -> Son başvuru zamanı
const pendingApplications = new Map(); // Admin Mesaj ID -> Başvuran Kullanıcı ID

// Stoat REST API İstek Fonksiyonu
async function sendApiRequest(endpoint, method = "GET", payload = null) {
    const response = await fetch(`https://api.stoat.chat${endpoint}`, {
        method,
        headers: {
            "x-bot-token": BOT_TOKEN,
            "content-type": "application/json"
        },
        body: payload ? JSON.stringify(payload) : null
    });

    const responseData = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`API Error [${response.status}]: ${JSON.stringify(responseData)}`);
    }
    return responseData;
}

// Kullanıcıya DM Gönderme Fonksiyonu
async function sendDirectMessage(userId, messageContent) {
    try {
        const dmChannel = await sendApiRequest(`/users/${userId}/dm`, "GET");
        if (dmChannel && dmChannel._id) {
            await sendApiRequest(`/channels/${dmChannel._id}/messages`, "POST", {
                content: messageContent
            });
            console.log(`[+] DM successfully delivered to ${userId}`);
        }
    } catch (error) {
        console.error(`[-] Failed to send DM to ${userId}:`, error.message);
    }
}

// WebSocket Bağlantısı ve Etkinlik Yönetimi
async function initializeWebSocketConnection() {
    try {
        console.log("[...] Fetching Stoat configuration...");
        const networkConfig = await sendApiRequest("/");
        const gatewayUrl = networkConfig.ws || "wss://events.stoat.chat";
        const socket = new WebSocket(`${gatewayUrl}?format=json`);
        let heartbeatIntervalId = null;

        socket.on("open", () => {
            console.log("[+] Gateway connection established, authenticating...");
            socket.send(JSON.stringify({
                type: "Authenticate",
                token: BOT_TOKEN
            }));
        });

        socket.on("message", async (rawMessage) => {
            let eventPayload;
            try {
                eventPayload = JSON.parse(rawMessage);
            } catch {
                return;
            }

            // Kimlik doğrulandıktan sonra kalp atışı (heartbeat) başlatılıyor
            if (eventPayload.type === "Authenticated") {
                console.log("[+] Authenticated! Heartbeat started...");
                heartbeatIntervalId = setInterval(() => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type: "Ping", data: 0 }));
                    }
                }, 30000);
            }

            // Bot hazır olduğunda durumunu Online yapar
            if (eventPayload.type === "Ready") {
                console.log("[🚀] NT_bot is online and monitoring channels!");
                console.log(`[+] Crew apply message ID: ${CREW_MESSAGE_ID}`);
                console.log(`[+] Welcome message ID: ${MEMBER_WELCOME_MSG_ID}`);
                socket.send(JSON.stringify({
                    type: "SetStatus",
                    status: { presence: "Online" }
                }));
            }

            // === TEPKİ VERİLDİĞİNDE ===
            if (eventPayload.type === "MessageReact") {
                if (eventPayload.user_id === BOT_ID) return;

                // 1. OTOMATİK ÜYE ROLÜ SİSTEMİ
                if (eventPayload.id === MEMBER_WELCOME_MSG_ID) {
                    try {
                        const targetMember = await sendApiRequest(`/servers/${SERVER_ID}/members/${eventPayload.user_id}`);
                        const userRoles = targetMember.roles || [];

                        if (!userRoles.includes(MEMBER_ROLE_ID)) {
                            await sendApiRequest(`/servers/${SERVER_ID}/members/${eventPayload.user_id}`, "PATCH", {
                                roles: [...userRoles, MEMBER_ROLE_ID]
                            });
                            console.log(`[✅] Member role granted -> ${eventPayload.user_id}`);
                        }
                    } catch (error) {
                        console.error("Failed to grant member role:", error.message);
                    }
                    return;
                }

                // 2. CREW BAŞVURUSU (🎯 EMOJİSİ)
                if (eventPayload.id === CREW_MESSAGE_ID) {
                    // Mesajın altındaki tepkiyi temizle
                    try {
                        await sendApiRequest(
                            `/channels/${CREW_CHANNEL_ID}/messages/${CREW_MESSAGE_ID}/reactions/${encodeURIComponent(eventPayload.emoji_id || CREW_EMOJI)}/${eventPayload.user_id}`,
                            "DELETE"
                        );
                    } catch {}

                    const currentTime = Date.now();
                    const lastApplicationTime = crewCooldowns.get(eventPayload.user_id) || 0;
                    const elapsedDuration = currentTime - lastApplicationTime;

                    // 1 saatlik cooldown kontrolü
                    if (elapsedDuration < CREW_COOLDOWN_MS) {
                        const remainingMinutes = Math.ceil((CREW_COOLDOWN_MS - elapsedDuration) / (60 * 1000));
                        console.log(`[⚠️] Cooldown active for ${eventPayload.user_id} (${remainingMinutes} mins left). Sending notification DM.`);
                        await sendDirectMessage(eventPayload.user_id, "Başvurunuz yakın zamanda alındı, lütfen sabırla bekleyin.");
                        return;
                    }

                    // Yeni başvuru kabul edildi
                    crewCooldowns.set(eventPayload.user_id, currentTime);
                    console.log(`[!] Valid Crew application received from: ${eventPayload.user_id}`);

                    // Yönetici kanalına bildirim kartı oluştur
                    try {
                        const adminNotification = await sendApiRequest(`/channels/${CREW_ADMIN_CHANNEL_ID}/messages`, "POST", {
                            content: `🎯 **Yeni Crew Rolü Başvurusu!**\n**Başvuran:** <@${eventPayload.user_id}> (ID: \`${eventPayload.user_id}\`)\n\nRolü vermek için aşağıdaki ✅, reddetmek için ❌ emojisine tıklayın.`
                        });

                        pendingApplications.set(adminNotification._id, eventPayload.user_id);

                        await sendApiRequest(`/channels/${CREW_ADMIN_CHANNEL_ID}/messages/${adminNotification._id}/reactions/✅`, "PUT");
                        await sendApiRequest(`/channels/${CREW_ADMIN_CHANNEL_ID}/messages/${adminNotification._id}/reactions/❌`, "PUT");
                    } catch (error) {
                        console.error("Failed to post admin notification:", error.message);
                    }
                    return;
                }

                // 3. YÖNETİCİNİN ONAY / RED KARARI
                if (pendingApplications.has(eventPayload.id)) {
                    const targetApplicantId = pendingApplications.get(eventPayload.id);
                    const selectedEmoji = eventPayload.emoji_id;

                    if (selectedEmoji === "✅") {
                        try {
                            const memberData = await sendApiRequest(`/servers/${SERVER_ID}/members/${targetApplicantId}`);
                            const currentRoles = memberData.roles || [];

                            if (!currentRoles.includes(CREW_ROLE_ID)) {
                                await sendApiRequest(`/servers/${SERVER_ID}/members/${targetApplicantId}`, "PATCH", {
                                    roles: [...currentRoles, CREW_ROLE_ID]
                                });
                            }

                            await sendApiRequest(`/channels/${CREW_ADMIN_CHANNEL_ID}/messages/${eventPayload.id}`, "PATCH", {
                                content: `✅ **CREW BAŞVURUSU ONAYLANDI!**\n**Üye:** <@${targetApplicantId}>\n**Onaylayan:** <@${eventPayload.user_id}>`
                            });

                            pendingApplications.delete(eventPayload.id);
                            console.log(`[✅] Crew role granted to: ${targetApplicantId}`);
                        } catch (error) {
                            console.error("Failed to approve Crew role:", error.message);
                        }
                    } else if (selectedEmoji === "❌") {
                        try {
                            await sendApiRequest(`/channels/${CREW_ADMIN_CHANNEL_ID}/messages/${eventPayload.id}`, "PATCH", {
                                content: `❌ **CREW BAŞVURUSU REDDEDİLDİ!**\n**Üye:** <@${targetApplicantId}>\n**İşlemi Yapan:** <@${eventPayload.user_id}>`
                            });

                            pendingApplications.delete(eventPayload.id);
                            console.log(`[❌] Crew application rejected for: ${targetApplicantId}`);
                        } catch (error) {
                            console.error("Failed to reject Crew application:", error.message);
                        }
                    }
                }
            }

            // === TEPKİ ÇEKİLDİĞİNDE (Sadece Üye Rolü) ===
            if (eventPayload.type === "MessageUnreact") {
                if (eventPayload.user_id === BOT_ID) return;

                if (eventPayload.id === MEMBER_WELCOME_MSG_ID) {
                    try {
                        const targetMember = await sendApiRequest(`/servers/${SERVER_ID}/members/${eventPayload.user_id}`);
                        const userRoles = targetMember.roles || [];

                        if (userRoles.includes(MEMBER_ROLE_ID)) {
                            const updatedRoleSet = userRoles.filter(roleId => roleId !== MEMBER_ROLE_ID);
                            await sendApiRequest(`/servers/${SERVER_ID}/members/${eventPayload.user_id}`, "PATCH", {
                                roles: updatedRoleSet
                            });
                            console.log(`[❌] Member role revoked from -> ${eventPayload.user_id}`);
                        }
                    } catch (error) {
                        console.error("Failed to revoke member role:", error.message);
                    }
                }
            }
        });

        socket.on("close", () => {
            clearInterval(heartbeatIntervalId);
            console.log("[-] Socket connection closed. Reconnecting in 5 seconds...");
            setTimeout(initializeWebSocketConnection, 5000);
        });

        socket.on("error", (error) => {
            console.error("WebSocket runtime error:", error.message);
        });

    } catch (error) {
        console.error("Connection initialization error:", error.message);
        setTimeout(initializeWebSocketConnection, 5000);
    }
}

initializeWebSocketConnection();