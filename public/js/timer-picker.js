/**
 * iOS-style Timer Wheel Picker
 * Allows users to select hours and minutes for game timer
 */

class TimerPicker {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.hoursValue = 0;
    this.minutesValue = 5; // Default to 5 minutes
    this.hoursWheel = null;
    this.minutesWheel = null;
    this.selectionIndicator = null;
    this.pickerElement = null;
    this.resizeRaf = null;
    this.visibleItemCount = 5;
    this.ignoreNextScroll = new WeakMap();
    this.lastEmittedValue = null;
    const win = typeof window !== 'undefined' ? window : null;
    this.requestFrame = win && win.requestAnimationFrame
      ? win.requestAnimationFrame.bind(win)
      : (callback) => setTimeout(callback, 16);
    this.cancelFrame = win && win.cancelAnimationFrame
      ? win.cancelAnimationFrame.bind(win)
      : (id) => clearTimeout(id);
    this.handleResize = this.handleResize.bind(this);
    this.init();
  }

  init() {
    if (!this.container) return;

    // Create picker HTML
    this.container.innerHTML = `
      <div class="timer-picker">
        <div class="timer-picker-wheels">
          <div class="timer-wheel-container">
            <div class="timer-wheel" id="hours-wheel" data-type="hours">
              ${this.generateWheelItems(0, 12, 'hour')}
            </div>
            <div class="timer-wheel-label">hours</div>
          </div>
          <div class="timer-wheel-separator">:</div>
          <div class="timer-wheel-container">
            <div class="timer-wheel" id="minutes-wheel" data-type="minutes">
              ${this.generateWheelItems(0, 59, 'min')}
            </div>
            <div class="timer-wheel-label">min</div>
          </div>
        </div>
        <div class="timer-picker-selection-indicator"></div>
      </div>
    `;

    this.pickerElement = this.container.querySelector('.timer-picker');
    this.hoursWheel = document.getElementById('hours-wheel');
    this.minutesWheel = document.getElementById('minutes-wheel');
    this.selectionIndicator = this.container.querySelector('.timer-picker-selection-indicator');

    // Initialize wheel positions
    this.setupWheel(this.hoursWheel, this.hoursValue);
    this.setupWheel(this.minutesWheel, this.minutesValue);

    // Add event listeners
    this.addScrollListeners();
    this.requestFrame(() => this.updateSelectionIndicatorPosition());
    this.emitChange();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.handleResize);
    }
  }

  generateWheelItems(min, max, suffix) {
    let items = '';
    // Add padding items at top and bottom for centering
    items += '<div class="timer-wheel-item timer-wheel-padding"></div>';
    items += '<div class="timer-wheel-item timer-wheel-padding"></div>';

    for (let i = min; i <= max; i++) {
      const value = i.toString().padStart(2, '0');
      items += `<div class="timer-wheel-item" data-value="${i}">${value}</div>`;
    }

    items += '<div class="timer-wheel-item timer-wheel-padding"></div>';
    items += '<div class="timer-wheel-item timer-wheel-padding"></div>';

    return items;
  }

  setupWheel(wheel, initialValue) {
    const { itemHeight, wheelHeight } = this.getWheelMetrics(wheel);
    const items = wheel.querySelectorAll('.timer-wheel-item:not(.timer-wheel-padding)');
    const paddingCount = this.getPaddingCount(wheel);

    // Find the index of the initial value
    let targetIndex = 0;
    items.forEach((item, index) => {
      if (parseInt(item.dataset.value) === initialValue) {
        targetIndex = index;
      }
    });

    // Scroll to center the selected item in the wheel
    // We have 2 padding items at top, so actual position is targetIndex + 2
    // To center: scroll so item appears at (wheelHeight / 2) - (itemHeight / 2) from top
    const centerOffset = (wheelHeight / 2) - (itemHeight / 2);
    const scrollPosition = (targetIndex + paddingCount) * itemHeight - centerOffset;
    this.ignoreNextScroll.set(wheel, true);
    wheel.scrollTop = scrollPosition;
    this.requestFrame(() => {
      this.ignoreNextScroll.delete(wheel);
    });
  }

  addScrollListeners() {
    let scrollTimeout;

    const handleScroll = (wheel) => {
      if (this.ignoreNextScroll.get(wheel)) {
        this.updateSelectedValue(wheel);
        this.updateSelectionIndicatorPosition();
        return;
      }

      clearTimeout(scrollTimeout);

      scrollTimeout = setTimeout(() => {
        this.snapToNearestItem(wheel);
      }, 150);

      // Update opacity for 3D effect while scrolling
      this.updateSelectedValue(wheel);
      this.updateSelectionIndicatorPosition();
    };

    this.hoursWheel.addEventListener('scroll', () => handleScroll(this.hoursWheel));
    this.minutesWheel.addEventListener('scroll', () => handleScroll(this.minutesWheel));

    // Initial opacity update
    this.updateSelectedValue(this.hoursWheel);
    this.updateSelectedValue(this.minutesWheel);
    this.updateSelectionIndicatorPosition();
  }

  snapToNearestItem(wheel) {
    const { itemHeight, wheelHeight } = this.getWheelMetrics(wheel);
    const paddingCount = this.getPaddingCount(wheel);
    const totalItems = wheel.querySelectorAll('.timer-wheel-item').length;
    const centerOffset = (wheelHeight / 2) - (itemHeight / 2);
    const scrollTop = wheel.scrollTop;

    // Calculate which item should be centered
    const nearestIndex = Math.round((scrollTop + centerOffset) / itemHeight);
    const minIndex = paddingCount;
    const maxIndex = totalItems - paddingCount - 1;
    const clampedIndex = Math.max(minIndex, Math.min(nearestIndex, maxIndex));
    const snapPosition = clampedIndex * itemHeight - centerOffset;

    // Smooth scroll to snap position
    this.ignoreNextScroll.set(wheel, true);
    if (typeof wheel.scrollTo === 'function') {
      wheel.scrollTo({
        top: snapPosition,
        behavior: 'smooth'
      });
    } else {
      wheel.scrollTop = snapPosition;
    }

    // Update the selected value after snapping
    setTimeout(() => {
      this.ignoreNextScroll.set(wheel, true);
      wheel.scrollTop = snapPosition;
      this.updateSelectedValue(wheel);
      this.updateSelectionIndicatorPosition();
      this.requestFrame(() => {
        this.ignoreNextScroll.delete(wheel);
      });
    }, 150);
  }

  updateItemOpacity(wheel) {
    const { itemHeight } = this.getWheelMetrics(wheel);
    const wheelRect = wheel.getBoundingClientRect();
    const wheelCenter = wheelRect.top + wheelRect.height / 2;
    const items = wheel.querySelectorAll('.timer-wheel-item');
    let closestItem = null;
    let closestDistance = Infinity;
    const itemStates = [];

    items.forEach(item => {
      const itemRect = item.getBoundingClientRect();
      const itemCenter = itemRect.top + itemRect.height / 2;
      const distance = Math.abs(wheelCenter - itemCenter);

      // Calculate opacity and scale based on distance from center
      const rawMaxDistance = wheelRect.height / 2;
      const maxDistance = rawMaxDistance > 0 ? rawMaxDistance : itemHeight * (this.visibleItemCount / 2);
      const normalizedDistance = maxDistance > 0 ? Math.min(distance / maxDistance, 1) : 0;

      // Opacity: 1 at center, fades to 0.3 at edges
      const opacity = 1 - (normalizedDistance * 0.7);

      // Scale: 1 at center, shrinks to 0.85 at edges
      const scale = 1 - (normalizedDistance * 0.15);

      itemStates.push({ item, opacity, scale });

      if (!item.classList.contains('timer-wheel-padding') && distance < closestDistance) {
        closestDistance = distance;
        closestItem = item;
      }
    });

    itemStates.forEach(({ item, opacity, scale }) => {
      item.style.opacity = opacity;
      item.style.transform = `scale(${scale})`;
      if (item === closestItem) {
        item.classList.add('timer-wheel-item-selected');
      } else {
        item.classList.remove('timer-wheel-item-selected');
      }
    });

    return closestItem;
  }

  setSelectedValueFromItem(wheel, item) {
    if (!item || item.dataset.value === undefined) return;
    const value = parseInt(item.dataset.value, 10);
    if (Number.isNaN(value)) return;

    if (wheel.id === 'hours-wheel') {
      this.hoursValue = value;
    } else if (wheel.id === 'minutes-wheel') {
      this.minutesValue = value;
    }
  }

  updateSelectedValue(wheel) {
    const previousValue = this.getValue();
    const selectedItem = this.updateItemOpacity(wheel);
    this.setSelectedValueFromItem(wheel, selectedItem);
    if (this.getValue() !== previousValue) {
      this.emitChange();
    }
  }

  getWheelMetrics(wheel) {
    const firstItem = wheel.querySelector('.timer-wheel-item:not(.timer-wheel-padding)');
    let itemHeight = 44;

    if (firstItem) {
      itemHeight = firstItem.offsetHeight || itemHeight;
      if (!firstItem.offsetHeight && typeof window !== 'undefined') {
        const computedHeight = parseFloat(window.getComputedStyle(firstItem).height);
        if (!Number.isNaN(computedHeight) && computedHeight > 0) {
          itemHeight = computedHeight;
        }
      }
    } else if (typeof window !== 'undefined') {
      const context = this.pickerElement || wheel;
      if (context) {
        const cssVar = window.getComputedStyle(context).getPropertyValue('--timer-wheel-item-height');
        const parsed = parseFloat(cssVar);
        if (!Number.isNaN(parsed) && parsed > 0) {
          itemHeight = parsed;
        }
      }
    }

    const wheelHeight = wheel.clientHeight || (itemHeight * this.visibleItemCount);
    return { itemHeight, wheelHeight };
  }

  updateSelectionIndicatorPosition() {
    if (!this.selectionIndicator || !this.pickerElement || !this.hoursWheel) return;

    const pickerRect = this.pickerElement.getBoundingClientRect();
    const wheelRect = this.hoursWheel.getBoundingClientRect();
    const { itemHeight } = this.getWheelMetrics(this.hoursWheel);

    const indicatorHeight = itemHeight + 8; // Add subtle breathing room around selection
    const wheelCenter = wheelRect.top - pickerRect.top + (wheelRect.height / 2);

    this.selectionIndicator.style.height = `${indicatorHeight}px`;
    this.selectionIndicator.style.top = `${wheelCenter}px`;
    this.selectionIndicator.style.transform = 'translate(-50%, -50%)';
  }

  getPaddingCount(wheel) {
    const paddingItems = wheel.querySelectorAll('.timer-wheel-padding');
    if (!paddingItems.length) return 0;
    return Math.floor(paddingItems.length / 2);
  }

  handleResize() {
    if (!this.hoursWheel || !this.minutesWheel) return;

    if (this.resizeRaf) {
      this.cancelFrame(this.resizeRaf);
    }

    this.resizeRaf = this.requestFrame(() => {
      this.setupWheel(this.hoursWheel, this.hoursValue);
      this.setupWheel(this.minutesWheel, this.minutesValue);
      this.updateSelectedValue(this.hoursWheel);
      this.updateSelectedValue(this.minutesWheel);
      this.updateSelectionIndicatorPosition();
      this.emitChange();
      this.resizeRaf = null;
    });
  }

  getValue() {
    // Return total seconds
    return (this.hoursValue * 3600) + (this.minutesValue * 60);
  }

  getDisplayValue() {
    // Return formatted string
    const hours = this.hoursValue.toString().padStart(2, '0');
    const minutes = this.minutesValue.toString().padStart(2, '0');
    return `${hours}:${minutes}:00`;
  }

  setValue(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    this.hoursValue = Math.min(hours, 12); // Max 12 hours
    this.minutesValue = Math.min(minutes, 59);

    this.setupWheel(this.hoursWheel, this.hoursValue);
    this.setupWheel(this.minutesWheel, this.minutesValue);

    this.updateSelectedValue(this.hoursWheel);
    this.updateSelectedValue(this.minutesWheel);
    this.updateSelectionIndicatorPosition();
    this.emitChange();
  }

  resetToDefault() {
    this.setValue(300); // 00:05 default
  }

  emitChange() {
    if (!this.container) return;
    const totalSeconds = this.getValue();
    if (this.lastEmittedValue === totalSeconds) return;
    this.lastEmittedValue = totalSeconds;
    const eventDetail = {
      hours: this.hoursValue,
      minutes: this.minutesValue,
      totalSeconds
    };
    try {
      this.container.dispatchEvent(new CustomEvent('timerPickerChange', {
        detail: eventDetail,
        bubbles: true
      }));
    } catch (err) {
      // Fallback for environments without CustomEvent constructor
      if (typeof document !== 'undefined' && document.createEvent) {
        const fallbackEvent = document.createEvent('CustomEvent');
        fallbackEvent.initCustomEvent('timerPickerChange', true, true, eventDetail);
        this.container.dispatchEvent(fallbackEvent);
      }
    }
  }
}

// Export for use in forms
window.TimerPicker = TimerPicker;
