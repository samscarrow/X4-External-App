<template>
  <div class="card" :class="[ compact ? 'mt-1' : 'mt-4' ]">
    <div class="card-header">
      <h3 class="card-header-title">
        {{ $t('app.widgets.savegame_info.title') }}
      </h3>
      <button
        class="btn btn-sm btn-primary"
        @click="refreshData"
        :disabled="loading"
      >
        <font-awesome-icon :icon="loading ? 'spinner' : 'sync'" :spin="loading" />
        {{ $t('app.widgets.savegame_info.refresh') }}
      </button>
    </div>
    <div class="card-body resizable-element" :data-min-resizable-height="minResizableHeight">

      <!-- Loading State -->
      <div v-if="loading" class="text-center py-4">
        <font-awesome-icon icon="spinner" spin size="2x" class="text-primary" />
        <p class="mt-2">{{ $t('app.widgets.savegame_info.loading') }}</p>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="alert alert-warning" role="alert">
        <font-awesome-icon icon="exclamation-triangle" />
        {{ error }}
      </div>

      <!-- No Data State -->
      <div v-else-if="!savegame" class="text-center py-4 text-muted">
        <font-awesome-icon icon="file" size="2x" class="mb-2" />
        <p>{{ $t('app.widgets.savegame_info.no_data') }}</p>
        <small>{{ $t('app.widgets.savegame_info.configure_path') }}</small>
      </div>

      <!-- Data Display -->
      <div v-else class="savegame-info">
        <!-- Basic Info -->
        <div class="info-section mb-3">
          <div class="row">
            <div class="col-6">
              <div class="info-label">{{ $t('app.widgets.savegame_info.player') }}</div>
              <div class="info-value">{{ savegame.player_name }}</div>
            </div>
            <div class="col-6">
              <div class="info-label">{{ $t('app.widgets.savegame_info.credits') }}</div>
              <div class="info-value">{{ formatMoney(savegame.player_money) }}</div>
            </div>
          </div>
          <div class="row mt-2">
            <div class="col-6">
              <div class="info-label">{{ $t('app.widgets.savegame_info.playtime') }}</div>
              <div class="info-value">{{ formatPlaytime(savegame.playtime_seconds) }}</div>
            </div>
            <div class="col-6">
              <div class="info-label">{{ $t('app.widgets.savegame_info.version') }}</div>
              <div class="info-value">{{ savegame.game_version }}</div>
            </div>
          </div>
        </div>

        <!-- Summary Cards -->
        <div class="row g-2">
          <div class="col-4">
            <div class="summary-card" @click="activeTab = 'ships'">
              <div class="summary-icon">
                <font-awesome-icon icon="rocket" />
              </div>
              <div class="summary-value">{{ ships.length }}</div>
              <div class="summary-label">{{ $t('app.widgets.savegame_info.ships') }}</div>
            </div>
          </div>
          <div class="col-4">
            <div class="summary-card" @click="activeTab = 'stations'">
              <div class="summary-icon">
                <font-awesome-icon icon="building" />
              </div>
              <div class="summary-value">{{ stations.length }}</div>
              <div class="summary-label">{{ $t('app.widgets.savegame_info.stations') }}</div>
            </div>
          </div>
          <div class="col-4">
            <div class="summary-card" @click="activeTab = 'blueprints'">
              <div class="summary-icon">
                <font-awesome-icon icon="file-alt" />
              </div>
              <div class="summary-value">{{ blueprints.length }}</div>
              <div class="summary-label">{{ $t('app.widgets.savegame_info.blueprints') }}</div>
            </div>
          </div>
        </div>

        <!-- Tabs -->
        <ul class="nav nav-tabs mt-3" role="tablist">
          <li class="nav-item" role="presentation">
            <button
              class="nav-link"
              :class="{ active: activeTab === 'ships' }"
              @click="activeTab = 'ships'"
            >
              {{ $t('app.widgets.savegame_info.ships') }}
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button
              class="nav-link"
              :class="{ active: activeTab === 'stations' }"
              @click="activeTab = 'stations'"
            >
              {{ $t('app.widgets.savegame_info.stations') }}
            </button>
          </li>
          <li class="nav-item" role="presentation">
            <button
              class="nav-link"
              :class="{ active: activeTab === 'blueprints' }"
              @click="activeTab = 'blueprints'"
            >
              {{ $t('app.widgets.savegame_info.blueprints') }}
            </button>
          </li>
        </ul>

        <!-- Tab Content -->
        <div class="tab-content mt-2">
          <!-- Ships Tab -->
          <div v-if="activeTab === 'ships'" class="tab-pane active">
            <div v-if="ships.length === 0" class="text-muted text-center py-3">
              {{ $t('app.widgets.savegame_info.no_ships') }}
            </div>
            <div v-else class="list-group list-group-flush">
              <div
                v-for="ship in ships.slice(0, showLimit)"
                :key="ship.id"
                class="list-group-item"
              >
                <div class="d-flex justify-content-between align-items-start">
                  <div>
                    <strong>{{ ship.ship_name }}</strong>
                    <div class="text-muted small">{{ ship.ship_type }}</div>
                    <div class="text-muted small">{{ ship.sector }}</div>
                  </div>
                  <div class="text-end small">
                    <div>
                      <span class="text-muted">Hull:</span>
                      <span v-if="ship.hull_health !== null" :class="getHealthClass(ship.hull_health)">
                        {{ formatHealth(ship.hull_health) }}
                      </span>
                      <span v-else class="text-muted">N/A</span>
                    </div>
                    <div v-if="ship.shield_health !== null">
                      <span class="text-muted">Shield:</span>
                      <span :class="getHealthClass(ship.shield_health)">
                        {{ formatHealth(ship.shield_health) }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <button
                v-if="ships.length > showLimit"
                class="btn btn-sm btn-link"
                @click="showLimit += 10"
              >
                {{ $t('app.widgets.savegame_info.show_more') }} ({{ ships.length - showLimit }} {{ $t('app.widgets.savegame_info.remaining') }})
              </button>
            </div>
          </div>

          <!-- Stations Tab -->
          <div v-if="activeTab === 'stations'" class="tab-pane active">
            <div v-if="stations.length === 0" class="text-muted text-center py-3">
              {{ $t('app.widgets.savegame_info.no_stations') }}
            </div>
            <div v-else class="list-group list-group-flush">
              <div
                v-for="station in stations.slice(0, showLimit)"
                :key="station.id"
                class="list-group-item"
              >
                <div class="d-flex justify-content-between align-items-start">
                  <div>
                    <strong>{{ station.station_name }}</strong>
                    <div class="text-muted small">{{ station.sector }}</div>
                    <div class="text-muted small">Owner: {{ station.owner }}</div>
                  </div>
                  <div class="text-end small">
                    <div v-if="station.modules">{{ station.modules.length }} {{ $t('app.widgets.savegame_info.modules') }}</div>
                    <div v-if="station.inventory">{{ station.inventory.length }} {{ $t('app.widgets.savegame_info.wares') }}</div>
                  </div>
                </div>
              </div>
              <button
                v-if="stations.length > showLimit"
                class="btn btn-sm btn-link"
                @click="showLimit += 10"
              >
                {{ $t('app.widgets.savegame_info.show_more') }} ({{ stations.length - showLimit }} {{ $t('app.widgets.savegame_info.remaining') }})
              </button>
            </div>
          </div>

          <!-- Blueprints Tab -->
          <div v-if="activeTab === 'blueprints'" class="tab-pane active">
            <div v-if="blueprints.length === 0" class="text-muted text-center py-3">
              {{ $t('app.widgets.savegame_info.no_blueprints') }}
            </div>
            <div v-else class="list-group list-group-flush">
              <div
                v-for="bp in blueprints.slice(0, showLimit)"
                :key="bp.id"
                class="list-group-item"
              >
                <div class="d-flex justify-content-between align-items-center">
                  <div>
                    <strong>{{ bp.blueprint_name }}</strong>
                    <span class="badge bg-secondary ms-2">{{ bp.blueprint_type }}</span>
                  </div>
                  <div>
                    <font-awesome-icon
                      v-if="bp.is_owned"
                      icon="check-circle"
                      class="text-success"
                      title="Owned"
                    />
                    <font-awesome-icon
                      v-else
                      icon="times-circle"
                      class="text-muted"
                      title="Not Owned"
                    />
                  </div>
                </div>
              </div>
              <button
                v-if="blueprints.length > showLimit"
                class="btn btn-sm btn-link"
                @click="showLimit += 10"
              >
                {{ $t('app.widgets.savegame_info.show_more') }} ({{ blueprints.length - showLimit }} {{ $t('app.widgets.savegame_info.remaining') }})
              </button>
            </div>
          </div>
        </div>

        <!-- Last Updated -->
        <div class="text-muted small text-center mt-3">
          {{ $t('app.widgets.savegame_info.last_parsed') }}: {{ formatDate(savegame.parsed_at) }}
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    gameData: Object,
    maxHeight: {
      type: Number,
      default: 600
    },
  },
  inject: ['compact'],
  data() {
    return {
      loading: false,
      error: null,
      savegame: null,
      ships: [],
      stations: [],
      blueprints: [],
      activeTab: 'ships',
      showLimit: 10,
    }
  },
  computed: {
    minResizableHeight() {
      return 300;
    }
  },
  mounted() {
    this.loadSavegameData();
    // Auto-refresh every 30 seconds
    this.refreshInterval = setInterval(() => {
      this.loadSavegameData(true);
    }, 30000);
  },
  beforeUnmount() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  },
  methods: {
    async loadSavegameData(silent = false) {
      if (!silent) {
        this.loading = true;
      }
      this.error = null;

      try {
        // Fetch latest savegame
        const response = await fetch('/api/savegames/latest');

        if (!response.ok) {
          if (response.status === 404) {
            this.savegame = null;
            return;
          }
          throw new Error(`HTTP ${response.status}`);
        }

        const savegame = await response.json();

        // Fetch complete data
        const dataResponse = await fetch(`/api/savegames/${savegame.id}`);
        const fullData = await dataResponse.json();

        this.savegame = fullData;
        this.ships = fullData.ships || [];
        this.stations = fullData.stations || [];
        this.blueprints = fullData.blueprints || [];

      } catch (err) {
        this.error = this.$t('app.widgets.savegame_info.error_loading', { error: err.message });
        console.error('Failed to load savegame data:', err);
      } finally {
        this.loading = false;
      }
    },

    async refreshData() {
      this.showLimit = 10;
      await this.loadSavegameData();
    },

    formatMoney(value) {
      if (!value) return '0 Cr';
      return value.toLocaleString() + ' Cr';
    },

    formatPlaytime(seconds) {
      if (!seconds) return '0h';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    },

    formatDate(dateString) {
      if (!dateString) return 'N/A';
      const date = new Date(dateString);
      return date.toLocaleString();
    },

    formatHealth(value) {
      if (value === null || value === undefined) return 'N/A';
      return `${Math.round(value)}%`;
    },

    getHealthClass(value) {
      if (value === null || value === undefined) return '';

      if (value >= 80) {
        return 'text-success'; // Green for healthy
      } else if (value >= 50) {
        return 'text-warning'; // Yellow for damaged
      } else if (value >= 25) {
        return 'text-danger'; // Red for critical
      } else {
        return 'text-danger fw-bold'; // Bold red for very critical
      }
    }
  },

  watch: {
    activeTab() {
      this.showLimit = 10;
    }
  }
}
</script>

<style lang="scss" scoped>
.savegame-info {
  .info-section {
    padding: 0.5rem 0;
  }

  .info-label {
    font-size: 0.75rem;
    color: var(--bs-secondary);
    text-transform: uppercase;
  }

  .info-value {
    font-size: 1rem;
    font-weight: 600;
    color: var(--bs-body-color);
  }

  .summary-card {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.25rem;
    padding: 0.75rem;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;

    &:hover {
      background: rgba(255, 255, 255, 0.08);
      transform: translateY(-2px);
    }

    .summary-icon {
      font-size: 1.5rem;
      color: var(--bs-primary);
      margin-bottom: 0.25rem;
    }

    .summary-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--bs-body-color);
    }

    .summary-label {
      font-size: 0.75rem;
      color: var(--bs-secondary);
      text-transform: uppercase;
    }
  }

  .list-group-item {
    background: transparent;
    border-color: rgba(255, 255, 255, 0.1);
    padding: 0.75rem;
  }

  .nav-tabs {
    border-bottom-color: rgba(255, 255, 255, 0.1);

    .nav-link {
      color: var(--bs-secondary);
      border: none;
      border-bottom: 2px solid transparent;

      &:hover {
        border-bottom-color: rgba(255, 255, 255, 0.2);
      }

      &.active {
        color: var(--bs-primary);
        background: transparent;
        border-bottom-color: var(--bs-primary);
      }
    }
  }
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-header-title {
  margin: 0;
  font-size: 1.1rem;
}
</style>
