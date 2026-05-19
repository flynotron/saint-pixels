/**
 * script.js
 * Combined version integrating drawing logic + Shift+Panning override
 */

// --- Configuration ---
const CONFIG = {
    width: window.innerWidth,
    height: window.innerHeight,
    palette: 7
};

// --- State ---
const state = {
    isDrawing: false,
    lastX: 0,
    lastY: 0,
    isPanning: false,
    currentTool: 'pencil', // 'pencil', 'eraser'
    currentColor: '#000000',
    currentMode: 'draw' // 'draw' or 'pan'
};

// --- DOM Elements ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
// Assuming these exist in your HTML, or handle generic access
const overlay = document.getElementById('overlay'); // Example
const palette = document.getElementById('palette'); // Example
const tools = document.getElementById('tools');      // Example

// --- Canvas Resize & Init ---
function resizeCanvas() {
    canvas.width = CONFIG.width;
    canvas.height = CONFIG.height;
    // Reset background if needed
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resizeCanvas);
// Assume initial render is needed
// ctx.fillStyle = '#FFFFFF';
// ctx.fillRect(0,0, canvas.width, canvas.height);

// --- UI Setup (Assuming standard structure from your old file) ---
function initUI() {
    // Pencil
    tools?.addEventListener('click', (e) => {
        if(e.target.id === 'pencil') setTool('pencil');
    });
    // Eraser
    tools?.addEventListener('click', (e) => {
        if(e.target.id === 'eraser') setTool('eraser');
    });
    // Colors (Assuming a palette exists)
    const colorBtns = document.querySelectorAll('.color-btn');
    colorBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            state.currentColor = e.target.dataset.color || '#000000';
            ctx.strokeStyle = state.currentColor;
            ctx.fillStyle = state.currentColor;
        });
    });
    
    // Login / Overlay (Assuming they handle logic in previous turn)
    // ... (Your existing login logic here)
}
// initUI(); // Call after elements load

// --- Core Drawing Logic (From script2.js) ---
function setTool(tool) {
    state.currentTool = tool;
    // UI update if needed
}

// --- The Main Interaction Handler (Combined Logic) ---
function handleInput(e) {
    const { offsetX: x, offsetY: y } = e.target;
    
    // --- PAN OVERRIDE LOGIC ---
    // If Shift is held, FORCE PAN MODE regardless of click location or mode
    if (e.shiftKey) {
        state.currentMode = 'pan';
        state.isPanning = true;
        // Move the canvas element directly (assuming you control the canvas DOM position)
        // If you use a camera/viewport system, update that here:
        // camera.pan(x - lastX, y - lastY);
        return; // Stop drawing, start panning
    }

    // If Shift is NOT held, ensure we are in DRAW mode
    if (e.shiftKey === false && state.currentMode !== 'draw') {
        state.currentMode = 'draw';
    }

    // --- DRAWING LOGIC (If not Panning) ---
    if (state.currentMode === 'draw') {
        if (!state.isDrawing) {
            state.isDrawing = true;
            state.lastX = x;
            state.lastY = y;
            
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = 1;
            
            // Handle Tool Logic
            if (state.currentTool === 'eraser') {
                ctx.globalCompositeOperation = 'destination-out';
            } else {
                ctx.globalCompositeOperation = 'source-over';
                ctx.strokeStyle = state.currentColor;
            }
        }
    } else {
        // PAN MODE
        if (state.isPanning) {
            // UPDATE CAMERA/VIEWPORT
            // This is where the camera bounds check usually lives in your old code.
            // Here is the FIX: Only check bounds if Shift is NOT held.
            // (Since we entered this block, Shift IS held, so we usually ignore bounds).
            
            // If you have a Camera object:
            //camera.x += (x - lastX);
            // camera.y += (y - lastY);
            // camera.update();

            // If you have direct canvas DOM movement:
            canvas.style.left = (canvas.offsetLeft + (x - lastX)) + 'px';
            canvas.style.top = (canvas.offsetTop + (y - lastY)) + 'px';

            lastX = x;
            lastY = y;
            // return; // Do not draw
        }
    }

    // --- Drawing Execution (Only if not Panning) ---
    if (state.isDrawing) {
        ctx.lineTo(x, y);
        ctx.stroke();
        state.lastX = x;
        state.lastY = y;
    }
}

// --- Event Listeners (MouseDown, Move, Up, Out) ---
canvas.addEventListener('mousedown', e => {
    state.isDrawing = true;
    state.lastX = e.offsetX;
    state.lastY = e.offsetY;
});

canvas.addEventListener('mousemove', handleInput);
// Note: handleInput contains the SHIFT logic.

canvas.addEventListener('mouseup', () => {
    state.isDrawing = false;
    state.isPanning = false;
});

canvas.addEventListener('mouseout', () => {
    state.isDrawing = false;
    state.isPanning = false;
});

// --- Start ---
// (Ensure canvas is visible before mousedown)
// resizeCanvas(); // If canvas exists
// initUI();

// --- Comment for the Fix ---
// If you use a separate panning function (from your old script.js):
// function pan(e) {
//     // OLD LOGIC: Apply bounds check here.
//     // NEW LOGIC: Check e.shiftKey. If true, skip the bounds check.
// }
// The combined logic above replaces this if needed.
