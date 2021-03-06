/* 
 * This is an experimental Medium Level Virtual Machine, the idea is to create
 * a common target for code generators that is lower level than JavaScript but
 * that can be decompiled into JavaScript Just-in-Time or Ahead-of-Time.
 */

var BitMap = (function () {
  const ADDRESS_BITS_PER_WORD = 5;
  const BITS_PER_WORD = 1 << ADDRESS_BITS_PER_WORD;
  const BIT_INDEX_MASK = BITS_PER_WORD - 1;
  function bitMap(length) {
    this.length = length;
    this.size = ((length + (BITS_PER_WORD - 1)) >> ADDRESS_BITS_PER_WORD) << ADDRESS_BITS_PER_WORD; 
    this.bits = new Uint32Array(this.size >> ADDRESS_BITS_PER_WORD);
  }
  bitMap.prototype.set = function set(i) {
    this.bits[i >> ADDRESS_BITS_PER_WORD] |= 1 << (i & BIT_INDEX_MASK);
  };
  bitMap.prototype.setAll = function setAll() {
    var bits = this.bits;
    for (var i = 0, j = bits.length; i < j; i++) {
      bits[i] = 0xFFFFFFFF;
    }
  };
  bitMap.prototype.clear = function clear(i) {
    this.bits[i >> ADDRESS_BITS_PER_WORD] &= ~(1 << (i & BIT_INDEX_MASK));
  };
  bitMap.prototype.get = function get(i) {
    var word = this.bits[i >> ADDRESS_BITS_PER_WORD];
    return ((word & 1 << (i & BIT_INDEX_MASK))) !== 0;
  };
  bitMap.prototype.clearAll = function clearAll() {
    var bits = this.bits;
    for (var i = 0, j = bits.length; i < j; i++) {
      bits[i] = 0;
    }
  };
  return bitMap;
})();

var NodeSet = (function () {
  function nodeSet(nodes) {
    this.nodes = nodes;
    this.map = new BitMap(nodes.length);
  }
  nodeSet.prototype.set = function set(node) {
    this.map.set(node.id);
  };
  nodeSet.prototype.get = function get(node) {
    return this.map.get(node.id);
  };
  nodeSet.prototype.toString = function toString() {
    var list = [];
    this.forEach(list.push.bind(list));
    return "{" + list.join(", ") + "}";
  };
  nodeSet.prototype.forEach = function forEach(fn) {
    for (var i = 0; i < this.map.length; i++) {
      if (this.map.get(i)) {
        fn(this.nodes[i]);
      }
    }
  }
  return nodeSet;
})();

var Node = (function () {
  function node() {
    this.id = -1;
  }
  return node;
})();

var Block = (function () {
  function block() {
    Node.call(this);
    this.predecessors = [];
    this.last = null;
  }
  Object.defineProperty(block.prototype, "successors", {
    get: function () {
      return this.last.successors;
    }, 
    set: function (v) {
      return this.last.successors = v;
    }
  });
  block.prototype.toString = function toString() {
    var s = this.successors.map(function (block) { return block.id; }).join(",");
    // return "B" + this.id + "[" + s + "]";
    return "B" + this.id;
  }
  return block;
})();

var Branch = (function () {
  function branch() {
    Node.call(this);
    this.successors = [];
  }
  return branch;
})();

var Graph = (function () {
  function graph() {
    this.nodes = [];
  }
  graph.prototype.register = function register(node) {
    assert(node.id === -1);
    node.id = this.nodes.length;
    this.nodes.push(node);
  };
  Object.defineProperty(graph.prototype, "root", {
    get: function () {
      assert(this.nodes.length > 0);
      return this.nodes[0];
    }
  });
  graph.prototype.traceGraphViz = function traceGraphViz(writer) {
    function bitPos(v) {
      for (var i = 0; i < 32; i++) {
        if ((v & (1 << i)) > 0) {
          return i + 1;
        }
      }
      return 0;
    }
    writeGraphViz(writer, this.root,
      function id(block) {
        assert(block);
        return block.id;
      },
      function successors(block) {
        return block.successors;
      }, null, 
      function name(block) {
        var str = "Block: " + block.id;
        str += (block.dominator ? ", idom: " + block.dominator.id : "");
        str += (block.isLoopHeader ? " [loop header]" : "");
        str += (block.interval ? ", interval: " + block.interval.header.id : "");
        str += ('loops' in block ? " [loops " + block.loops + "]" : "");
        return str;
      }, {
        color: function (block) { 
          return 1 + (block.interval ? block.interval.header.id % 10 : 0) ; }
      } 
    );
  };
  graph.prototype.generateRandomGraph = function generateRandomGraph(size) {
    var blocks = [];
    for (var i = 0; i < size; i++) {
      var block = new Block();
      block.last = new Branch();
      blocks.push(block);
    }
    blocks.forEach(function (block) { this.register(block); }.bind(this));
    function randomBlock() {
      return blocks[1 + ((Math.random() * blocks.length - 1) | 0)];
    }
    for (var i = 0; i < size; i++) {
      if (((Math.random() * 4) | 0) === 0) {
        blocks[i].successors = [randomBlock(), randomBlock()];
      } else if (((Math.random() * 10) | 0) === 0) {
        blocks[i].successors = [randomBlock(), randomBlock(), randomBlock()];
      } else {
        blocks[i].successors = [randomBlock()];
      }
    }
  };
  graph.prototype.depthFirstSearch = function depthFirstSearch(preFn, postFn) {
    var visited = new BitMap(this.nodes.length);
    function visit(node) {
      visited.set(node.id);
      if (preFn) preFn(node);
      var successors = node.successors;
      for (var i = 0, j = successors.length; i < j; i++) {
        var s = successors[i];
        if (!visited.get(s.id)) visit(s);
      }
      if (postFn) postFn(node);
    }
    visit(this.root);
  };
  /**
   * Computes the immediate dominator relationship and returns a map of block IDs to their immediate 
   * dominator's block IDs. Optionally, this map can be applied to blocks directly, so that blocks 
   * point to their dominators directly.
   */
  graph.prototype.computeDominators = function computeDominators(apply) {
    var dom = new Int32Array(this.nodes.length);
    for (var i = 0; i < dom.length; i++) dom[i] = -1;
    var map = new BitMap(this.nodes.length);
    function computeCommonDominator(a, b) {
      map.clearAll();
      while (a >= 0) {
        map.set(a);
        a = dom[a];
      }
      while (b >= 0 && !map.get(b)) {
        b = dom[b];
      }
      return b;
    }
    function computeDominator(blockId, parentId) {
      if (dom[blockId] < 0) {
        dom[blockId] = parentId;
      } else {
        dom[blockId] = computeCommonDominator(dom[blockId], parentId);
      }
    }
    this.depthFirstSearch(
      function visit(block) {
        var s = block.successors;
        for (var i = 0, j = s.length; i < j; i++) {
          computeDominator(s[i].id, block.id);
        }
      }
    );
    if (apply) {
      for (var i = 0, j = this.nodes.length; i < j; i++) {
        this.nodes[i].dominator = this.nodes[dom[i]];
      }
    }
    return dom;
  }
  graph.prototype.detectLoopHeaders = function detectLoopHeaders() {
    var active = new BitMap(this.nodes.length);
    var visited = new BitMap(this.nodes.length);
    var nextLoop = 0;
    
    function makeLoopHeader(block) {
      if (!block.isLoopHeader) {
        assert(nextLoop < 32, "Can't handle too many loops, fall back on BitMaps if it's a problem.");
        block.isLoopHeader = true;
        block.loops = 1 << nextLoop;
        nextLoop += 1;
      }
      assert(bitCount(block.loops) === 1);
    }
    
    function visit(block) {
      if (visited.get(block.id)) {
        if (active.get(block.id)) {
          makeLoopHeader(block);
        }
        return block.loops;
      }
      visited.set(block.id);
      active.set(block.id);
      var loops = 0;
      for (var i = 0, j = block.successors.length; i < j; i++) {
        loops |= visit(block.successors[i]);
      }
      if (block.isLoopHeader) {
        assert(bitCount(block.loops) === 1);
        loops &= ~block.loops;
      }
      block.loops = loops;
      active.clear(block.id);
      return loops;
    }
    
    var loop = visit(this.root);
    assert(loop === 0);
  }
  graph.prototype.computeReversePostOrder = function computeReversePostOrder() {
    var order = [];
    this.depthFirstSearch(null, order.push.bind(order));
    order.reverse();
    return order;
  };
  graph.prototype.computePredecessors = function computePredecessors() {
    this.nodes.forEach(function (node) {
      node.successors.forEach(function (succ) {
        succ.predecessors.push(node);
      });
    });
  };
  /**
   * Computes the Allen-Cocke interval partitioning. Optionally, the interval information can be applied to blocks 
   * directly, so that blocks point to their containing interval.
   */
  graph.prototype.computeIntervals = function computeIntervals(apply) {
    var order = this.computeReversePostOrder();
    
    var headers = [this.root];
    var processedHeaders = new NodeSet(this.nodes);

    // console.info("Reverse Post Order: " + order);
    
    var intervals = [];
    while (headers.length > 0) {
      var header = headers.pop();
      processedHeaders.set(header);
      
      var interval = new NodeSet(this.nodes);
      interval.set(header);
      
      console.info("Interval: " + interval);
      
      /**
       * Expand interval by adding all nodes whose predecessors are within the interval.
       */
      var expandedInterval = true;
      while (expandedInterval) {
        expandedInterval = false;
        for (var i = 0; i < order.length; i++) {
          var node = order[i];
          console.info("Node: " + node + ", predecessors: " + node.predecessors);
          if (node === this.root) {
            continue;
          }
          if (interval.get(node)) {
            continue;
          }
          
          var allPredecessorsInInterval = node.predecessors.length > 0;
          for (var j = 0; j < node.predecessors.length; j++) {
            var predecessor = node.predecessors[j];  
            if (!interval.get(predecessor)) {
              allPredecessorsInInterval = false;
              break;
            }
          }
          if (allPredecessorsInInterval) {
            console.info("Node: " + node + " has all preds " + node.predecessors + " in interval " + interval);
            interval.set(node);
            expandedInterval = true;
            console.info("Expanded Interval: " + interval);
          }
        }
      }
      
      intervals.push({header: header, body: interval});
      
      /**
       * Add header nodes which have not been processed and have at least one predecessor in the interval.
       */
      for (var i = 0; i < order.length; i++) {
        var node = order[i];
        console.info("Node: " + node + ", processedHeaders: " + processedHeaders);
        if (processedHeaders.get(node)) {
          continue;
        }
        console.info("Int: " + interval);
        if (interval.get(node)) {
          continue;
        }
        console.info("Node Preds: " + node.predecessors);
        for (var j = 0; j < node.predecessors.length; j++) {
          var predecessor = node.predecessors[j];
          console.info("Pred: " + predecessor);
          if (interval.get(predecessor)) {
            headers.push(node);
            break;
          }
        }
      }
    }

    if (apply) {
      intervals.forEach(function (interval) {
        interval.body.forEach(function (node) {
          node.interval = interval;
        });
      });  
    }
    
    intervals.forEach(function (interval) {
      console.info("Interval: header: " + interval.header + ", nodes: " + interval.body);
    });
  };
  return graph;
})();

function createGraph(analysis) {
  var graph = new Graph();
  var blockMap = [];
  analysis.dfs(analysis.bytecodes[0], function (i) {
    var block = new Block();
    block.last = new Branch();
    blockMap[i.blockId] = block;
    graph.register(block);
  });
  analysis.dfs(analysis.bytecodes[0], function (i) {
    var block = blockMap[i.blockId];
    block.successors = i.succs.map(function (j) { return blockMap[j.blockId]; });
  });
  graph.computeDominators(true);
  graph.detectLoopHeaders();
  return graph;
}

function createGraphEx() {
  var graph = new Graph();
  graph.generateRandomGraph(500);
  graph.computeDominators(true);
  return graph;
}