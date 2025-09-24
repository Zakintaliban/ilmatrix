# Project Structure Overview

This document provides a quick overview of the refactored ILMATRIX project structure.

## Directory Structure

```
src/
├── config/
│   └── env.ts                    # Centralized configuration management
├── services/
│   ├── materialService.ts        # Material CRUD operations and file management
│   ├── extractionService.ts      # File content extraction coordination
│   ├── groqService.ts           # AI/LLM service integration
│   ├── mcqScoringService.ts     # Deterministic quiz scoring (no LLM)
│   └── backgroundTaskService.ts  # Background cleanup tasks
├── controllers/
│   ├── uploadController.ts       # File upload HTTP handling
│   ├── materialController.ts     # Material management HTTP endpoints
│   └── aiController.ts          # AI feature HTTP endpoints
├── middleware/
│   └── rateLimit.ts             # Enhanced rate limiting middleware
├── utils/
│   ├── concurrency.ts           # p-limit style concurrency management
│   └── security.ts              # Security utilities and validation
├── extract/                     # File extraction modules (unchanged)
│   ├── pdf.ts
│   ├── image.ts
│   ├── docx.ts
│   └── pptx.ts
├── routes.ts                    # Clean API route definitions
└── server.ts                    # Improved server bootstrap
```

## Key Principles

### Separation of Concerns

- **Controllers**: Handle HTTP requests/responses only
- **Services**: Contain business logic and external integrations
- **Utils**: Provide reusable utility functions
- **Middleware**: Process requests before they reach controllers

### Configuration Management

- All environment variables centralized in `config/env.ts`
- Type-safe configuration with validation
- Environment-aware defaults

### Error Handling

- Consistent error responses across all layers
- Proper error logging and debugging information
- Graceful degradation when services unavailable

### Security

- Enhanced path traversal protection
- Comprehensive input validation
- Improved rate limiting with proper HTTP headers

## Service Dependencies

```
routes.ts
├── controllers/
│   ├── uploadController → extractionService, materialService
│   ├── materialController → materialService
│   └── aiController → groqService, mcqScoringService, materialService
├── middleware/
│   └── rateLimit → utils/security
└── services/
    └── backgroundTaskService → materialService
```

## Development Workflow

1. **New Features**: Start with services for business logic
2. **HTTP Endpoints**: Add controllers to handle requests
3. **Cross-cutting Concerns**: Use middleware for request processing
4. **Utilities**: Extract reusable functions to utils/
5. **Configuration**: Add new settings to config/env.ts

## Testing Strategy

- **Unit Tests**: Test services independently
- **Integration Tests**: Test controller + service combinations
- **Smoke Tests**: Verify API contracts work end-to-end

## Legacy Compatibility

- All original files preserved in `backup/legacy/`
- API contracts remain unchanged
- Environment variables fully compatible
- Frontend requires no modifications
