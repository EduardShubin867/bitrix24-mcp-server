import { executeToolCall } from '../build/tools/index.js';

async function runSmoke() {
  console.log('Testing Bitrix24 task MCP tools...\n');

  console.log('1. bitrix24_get_current_user');
  const currentUser = await executeToolCall('bitrix24_get_current_user', {});
  if (!currentUser.success) {
    throw new Error(`Current user failed: ${currentUser.message || currentUser.error}`);
  }
  console.log(`OK: ${currentUser.user?.NAME || currentUser.user?.name || currentUser.user?.EMAIL || currentUser.user?.ID}`);

  console.log('\n2. bitrix24_list_my_tasks');
  const myTasks = await executeToolCall('bitrix24_list_my_tasks', {
    limit: 10
  });
  if (!myTasks.success) {
    throw new Error(`List my tasks failed: ${myTasks.message || myTasks.error}`);
  }
  console.log(`OK: ${myTasks.tasks.length} tasks returned`);

  const firstTask = myTasks.tasks[0];
  const firstTaskId = firstTask?.ID || firstTask?.id;
  if (!firstTaskId) {
    console.log('\nNo tasks returned, skipping bitrix24_get_task_full.');
    return;
  }

  console.log('\n3. bitrix24_get_task_full');
  const fullTask = await executeToolCall('bitrix24_get_task_full', {
    taskId: String(firstTaskId),
    includeChatMessages: false,
    includeFiles: false
  });
  if (!fullTask.success) {
    throw new Error(`Get full task failed: ${fullTask.message || fullTask.error}`);
  }
  console.log(`OK: task ${fullTask.task?.ID || fullTask.task?.id} retrieved`);
}

runSmoke().catch((error) => {
  console.error('\nSmoke test failed:', error.message);
  process.exit(1);
});
