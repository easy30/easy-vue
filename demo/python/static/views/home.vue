<template>
  <div class="card">
    <h2>Home</h2>
    <p class="msg">服务端返回：{{ msg }}</p>
    <button @click="n++">点我 +1 → n = {{ n }}</button>
  </div>
</template>
<script setup>
import { ref, onMounted } from 'vue';
const n = ref(0);
const msg = ref('加载中…');
onMounted(async () => {
  const r = await fetch('/api/title');
  msg.value = (await r.json()).title;
});
</script>
<style scoped>
.card { border:1px solid #ccc; border-radius:8px; padding:16px; max-width:320px }
.msg  { color:#06c }
</style>
