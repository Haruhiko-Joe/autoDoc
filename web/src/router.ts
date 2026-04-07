import { createRouter, createWebHistory } from 'vue-router'
import HomePage from './views/HomePage.vue'
import GraphPage from './views/GraphPage.vue'
import FlowsPage from './views/FlowsPage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/:project', name: 'project', component: HomePage },
    { path: '/:project/flows', name: 'flows', component: FlowsPage },
    { path: '/:project/doc/:path(.*)', name: 'doc', component: GraphPage },
  ],
})

export default router
