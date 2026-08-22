// sample — ValueScript demo. Compile with: vsc compile src/index.vs -o dist

let user = { name: 'Ada', meta: { role: 'admin' } };
user.name = 'Grace';
user.meta.role = 'editor';

let list = [1, 2, 3];
list.push(4);
list = list.slice(1);

let state = { history: [], counter: 0 };
state.history.push('boot');
state.counter = state.counter + 1;

function build(points) {
  let acc = [];
  for (let i = 0; i < points.length; i++) {
    acc.push(points[i] * 2);
  }
  return acc;
}

console.log(user, list, state, build([1, 2, 3]));