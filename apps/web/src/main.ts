import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router/index.js";
import { useAttendanceQueueStore } from "./stores/attendanceQueue.js";
import "./styles/main.css";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);

// 恢复网络后自动回放离线期间的到勤确认（幂等，重复回放安全）
const attendanceQueue = useAttendanceQueueStore(pinia);
window.addEventListener("online", () => attendanceQueue.updateOnline(true));
window.addEventListener("offline", () => attendanceQueue.updateOnline(false));
if (attendanceQueue.online) void attendanceQueue.flush();

app.mount("#app");
