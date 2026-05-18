const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');

// Initial setup variables
let isDrawing = false;
let isPanning = false;
let lastX = 0;
let lastY = 0;

// Panning state (The offset applied to the canvas context)
let panX = 0;
let panY = 0;

// Drawing state
let currentColor = '#000000';
let currentSize = 5;

// --- Initialization Functions ---

function initializeCanvas() {
    // Set initial dimensions to match CSS/viewport setup if necessary
    // We rely on CSS for initial sizing, but we must ensure the canvas element
    // is properly drawn upon initialization.
    
    // Set initial drawing context state (important for transformations)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Initialize view to origin
    resetView();
}

function resetView() {
    panX = 0;
    panY = 0;
    // Re-apply the translation/scale matrix to reset the view
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform matrix
    canvas.style.transform = 'translate(0, 0)';
    // Note: If you are using the transform property on the canvas itself, 
    // you might need to manage it differently based on CSS implementation.
    // For pure context manipulation, setting the transform is key.
    ctx.save(); // Save the initial state
    ctx.translate(panX, panY); // Apply current pan offset
    ctx.restore();
}


// --- Context Management / Transformation ---

/**
 * Applies the current pan offset to the context transformation.
 * This must be called BEFORE drawing/calculating positions.
 */
function applyViewTransform() {
    // Save the current state before applying the pan transform
    ctx.save();
    // Translate the context so that coordinates drawn are relative to (panX, panY)
    ctx.translate(panX, panY); 
}

/**
 * Cleans up the context transformation after drawing/panning actions.
 */
function restoreViewTransform() {
    // Restore the context state to undo the translation
    ctx.restore();
}


// --- Drawing Handlers ---

function startDrawing(e) {
    if (e.button !== 0) return; // Only respond to left click
    
    // Prevent panning if we are starting a draw action
    if (isPanning) return; 
    
    isDrawing = true;
    lastX = e.offsetX;
    lastY = e.offsetY;
    
    // Must apply transform before drawing the first point
    applyViewTransform(); 
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    // Restore immediately if the next event handler will re-apply transform
    // For simplicity, let's manage the restore/apply cycle per movement event.
}

function draw(e) {
    if (!isDrawing) return;

    // Crucial: The coordinates received from mousemove (e.offsetX/Y) 
    // are relative to the *visible* canvas element.
    // If we are panning, we must calculate the drawing position based on the pan offset.
    
    // 1. Get the current relative position of the mouse cursor on the visible canvas
    const currentX = e.offsetX;
    const currentY = e.offsetY;
    
    // 2. Apply view transform before drawing
    applyViewTransform();
    
    // 3. Draw line segment
    ctx.lineTo(currentX, currentY);
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentSize;
    ctx.lineCap = 'round';
    ctx.stroke();
    
    // 4. Move the starting point for the next segment
    ctx.beginPath();
    ctx.moveTo(currentX, currentY);
    
    // 5. Restore the context state so subsequent events can correctly read/write
    restoreViewTransform();
    
    lastX = currentX;
    lastY = currentY;
}

function stopDrawing() {
    if (isDrawing) {
        isDrawing = false;
        // Ensure the path is closed properly after drawing stops
        ctx.closePath();
        restoreViewTransform();
    }
}


// --- Panning Handlers ---

function startPanning(e) {
    // Only start panning if it's a click on the canvas and not a draw action
    if (e.button !== 0 || isDrawing) return;

    isPanning = true;
    lastX = e.clientX;
    lastY = e.clientY;
    
    // Prevent default browser drag behavior (like image dragging)
    e.preventDefault();
}

function doPanning(e) {
    if (!isPanning) return;
    
    const deltaX = e.clientX - lastX;
    const deltaY = e.clientY - lastY;

    // Update the global pan offsets
    panX += deltaX;
    panY += deltaY;
    
    // 1. Update the canvas visual position (CSS transform is usually best for performance)
    canvas.style.transform = `translate(${panX}px, ${panY}px)`;
    
    // 2. Update the context transformation matrix (This is crucial if other context drawing relies on it)
    // Although we set the transform via CSS, maintaining the context's internal state 
    // helps keep drawing logic consistent.
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset context matrix first
    ctx.translate(panX, panY); // Then apply the new view offset
    
    lastX = e.clientX;
    lastY = e.clientY;
}

function stopPanning() {
    isPanning = false;
}

// --- Event Listeners Setup ---

function setupEventListeners() {
    // 1. Drawing Events
    canvas.addEventListener('mousedown', (e) => {
        // Check if we are trying to draw or pan. If we start by clicking in the center, assume draw.
        // A simple heuristic: If the mouse moves significantly (e.g., > 5px) before releasing, 
        // it might be panning. For simplicity, we let the drag logic decide.
        
        // We prioritize drawing first. Panning only occurs if drawing is explicitly disabled/ignored.
        startDrawing(e); 
    });
    canvas.addEventListener('mousemove', (e) => {
        if (isDrawing) {
            draw(e);
        } else if (isPanning) {
            doPanning(e);
        }
    });
    canvas.addEventListener('mouseup', (e) => {
        stopDrawing();
        stopPanning();
    });
    canvas.addEventListener('mouseleave', () => {
        stopDrawing();
        stopPanning();
    });
    
    // 2. Panning Activation (Right Click or Context Menu Handler)
    // We hijack the right-click context menu to enable panning mode.
    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault(); // Stop default context menu
        
        // Switch mode: If we are drawing, stop. If not, start panning.
        if (!isDrawing) {
             isPanning = true;
             lastX = e.clientX;
             lastY = e.clientY;
        }
    });
    
    // Add global mouseup listener to ensure panning stops even if cursor leaves canvas boundaries
    document.addEventListener('mouseup', stopPanning); 
}

// --- Utility Functions (Assuming these exist or need setup) ---
function setCanvasSize(width, height) {
    // Assumes canvas element has ID 'drawingCanvas'
    const canvas = document.getElementById('drawingCanvas');
    if (canvas) {
        canvas.width = width;
        canvas.height = height;
    }
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Initialize canvas size (e.g., to 1000x600)
    setCanvasSize(1000, 600);
    
    // Attach listeners for drawing/interaction
    document.getElementById('drawingCanvas').addEventListener('mousedown', (e) => {
        if (e.button === 0) { // Left mouse button
            // Start drawing logic (e.g., save the initial position)
            // For simplicity, we'll rely on mousedown starting the drag
        }
    });
    // Note: The actual drawing logic (which needs to draw segments) is omitted here
    // as it requires complex state management (e.g., drawing coordinates array).
    // We focus on the pan/zoom/click mechanics.
});