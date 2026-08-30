<template>
  <div class="wrap">
    <h2>Users</h2>
    <p class="src">数据来自后端 mock：GET /api/userList</p>
    <table>
      <thead><tr><th>ID</th><th>姓名</th><th>年龄</th><th>角色</th></tr></thead>
      <tbody>
        <tr v-for="u in list" :key="u.id">
          <td>{{ u.id }}</td><td>{{ u.name }}</td><td>{{ u.age }}</td><td>{{ u.role }}</td>
        </tr>
      </tbody>
    </table>
    <p class="total">共 {{ total }} 人（版本 {{ ver }}）</p>
  </div>
</template>
<script setup>
import { ref, onMounted } from 'vue';
import { formatUser, APP_VERSION } from './util.ts';   /* ← .ts 也现场编译 */
const list = ref([]);
const total = ref(0);
const ver = APP_VERSION;
onMounted(async () => {
  const r = await fetch('/api/userList');
  const data = await r.json();
  list.value = data.list;
  total.value = data.total;
});
</script>
<style scoped>
.wrap { max-width:420px }
.src { color:#888; font-size:12px }
table { border-collapse:collapse; width:100% }
th, td { border:1px solid #ccc; padding:6px 10px; text-align:left }
th { background:#f5f5f5 }
.total { color:#06c }
</style>
