<template>
  <div class="box">
    <h1>{{ msg }}</h1>
    <p>这个 .vue 由 easy-vue 在浏览器请求时现场编译成 ESM JS。</p>
    <button @click="count++">点了 {{ count }} 次</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'
const msg = 'Hello easy-vue'
const count = ref(0)
</script>

<style>
.box { font-family: sans-serif; text-align: center; margin-top: 80px; color: #333; }
button { font-size: 16px; padding: 8px 20px; cursor: pointer; }
</style>
