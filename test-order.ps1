# Complete End-to-End Order Placement Test via MedusaJS API
# This demonstrates the Definition of Done: "A provisioned store must support placing an order end-to-end"

$baseUrl = "http://store-myshop.local.gd"
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  MedusaJS E-Commerce Order Placement Test (9-Step Flow)  " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

try {
    # Step 1: Health Check
    Write-Host "[1/9] Health Check..." -ForegroundColor Yellow
    $health = Invoke-WebRequest -Uri "$baseUrl/health" -UseBasicParsing -ErrorAction Stop
    Write-Host "  - Store is healthy" -ForegroundColor Green
    Write-Host ""

    # Step 2: Get Regions
    Write-Host "[2/9] Fetching regions..." -ForegroundColor Yellow
    $regionsResp = Invoke-WebRequest -Uri "$baseUrl/store/regions" -UseBasicParsing -ErrorAction Stop
    $regions = ($regionsResp.Content | ConvertFrom-Json).regions
    $region = $regions[0]
    $regionId = $region.id
    
    # Get a valid country from the region
    $validCountry = $region.countries[0].iso_2
    Write-Host "  - Using region: $($region.name) (ID: $regionId)" -ForegroundColor Green
    Write-Host "  - Valid country for region: $validCountry" -ForegroundColor Gray
    Write-Host ""

    # Step 3: Get Products
    Write-Host "[3/9] Fetching products..." -ForegroundColor Yellow
    $productsResp = Invoke-WebRequest -Uri "$baseUrl/store/products" -UseBasicParsing -ErrorAction Stop
    $products = ($productsResp.Content | ConvertFrom-Json).products
    if ($products.count -eq 0) {
        throw "No products available in store"
    }
    $product = $products[0]
    $variantId = $product.variants[0].id
    Write-Host "  - Found product: $($product.title) (Variant ID: $variantId)" -ForegroundColor Green
    Write-Host ""

    # Step 4: Create Cart
    Write-Host "[4/9] Creating shopping cart..." -ForegroundColor Yellow
    $cartBody = @{ region_id = $regionId } | ConvertTo-Json
    $cartResp = Invoke-WebRequest -Uri "$baseUrl/store/carts" -Method Post -Body $cartBody -ContentType "application/json" -UseBasicParsing -ErrorAction Stop
    $cart = ($cartResp.Content | ConvertFrom-Json).cart
    $cartId = $cart.id
    Write-Host "  - Cart created: $cartId" -ForegroundColor Green
    Write-Host ""

    # Step 5: Add Item to Cart
    Write-Host "[5/9] Adding product to cart..." -ForegroundColor Yellow
    $lineItemBody = @{ variant_id = $variantId; quantity = 1 } | ConvertTo-Json
    $addItemResp = Invoke-WebRequest -Uri "$baseUrl/store/carts/$cartId/line-items" -Method Post -Body $lineItemBody -ContentType "application/json" -UseBasicParsing -ErrorAction Stop
    $updatedCart = ($addItemResp.Content | ConvertFrom-Json).cart
    Write-Host "  - Added $($updatedCart.items[0].title) x $($updatedCart.items[0].quantity)" -ForegroundColor Green
    Write-Host ""

    # Step 6: Add Shipping Address
    Write-Host "[6/9] Adding shipping address..." -ForegroundColor Yellow
    $addressBody = @{
        shipping_address = @{
            first_name = "Test"
            last_name = "User"
            address_1 = "123 Test Street"
            city = "Test City"
            country_code = $validCountry
            postal_code = "12345"
            phone = "555-1234"
        }
        email = "test@example.com"
    } | ConvertTo-Json -Depth 3
    $addressResp = Invoke-WebRequest -Uri "$baseUrl/store/carts/$cartId" -Method Post -Body $addressBody -ContentType "application/json" -UseBasicParsing -ErrorAction Stop
    Write-Host "  - Shipping address added" -ForegroundColor Green
    Write-Host ""

    # Step 7: Add Shipping Method
    Write-Host "[7/9] Selecting shipping method..." -ForegroundColor Yellow
    $shippingOptionsResp = Invoke-WebRequest -Uri "$baseUrl/store/shipping-options/$cartId" -UseBasicParsing -ErrorAction Stop
    $shippingOptions = ($shippingOptionsResp.Content | ConvertFrom-Json).shipping_options
    if ($shippingOptions.count -gt 0) {
        $shippingOptionId = $shippingOptions[0].id
        $shippingBody = @{ option_id = $shippingOptionId } | ConvertTo-Json
        Invoke-WebRequest -Uri "$baseUrl/store/carts/$cartId/shipping-methods" -Method Post -Body $shippingBody -ContentType "application/json" -UseBasicParsing -ErrorAction Stop | Out-Null
        Write-Host "  - Shipping method selected: $($shippingOptions[0].name)" -ForegroundColor Green
        Write-Host ""
    } else {
        Write-Host "  - WARNING: No shipping methods available (may require configuration)" -ForegroundColor Yellow
        Write-Host ""
    }

    # Step 8: Initialize Payment Session
    Write-Host "[8/9] Initializing payment session..." -ForegroundColor Yellow
    $paymentSessionResp = Invoke-WebRequest -Uri "$baseUrl/store/carts/$cartId/payment-sessions" -Method Post -ContentType "application/json" -UseBasicParsing -ErrorAction Stop
    $paymentCart = ($paymentSessionResp.Content | ConvertFrom-Json).cart
    
    # Select the first available payment provider
    if ($paymentCart.payment_sessions -and $paymentCart.payment_sessions.count -gt 0) {
        $paymentProviderId = $paymentCart.payment_sessions[0].provider_id
        $selectPaymentBody = @{ provider_id = $paymentProviderId } | ConvertTo-Json
        Invoke-WebRequest -Uri "$baseUrl/store/carts/$cartId/payment-session" -Method Post -Body $selectPaymentBody -ContentType "application/json" -UseBasicParsing -ErrorAction Stop | Out-Null
        Write-Host "  - Payment provider selected: $paymentProviderId" -ForegroundColor Green
        Write-Host ""
    } else {
        throw "No payment providers available"
    }

    # Step 9: Complete Order
    Write-Host "[9/9] Completing order..." -ForegroundColor Yellow
    $orderBody = @{} | ConvertTo-Json
    $orderResp = Invoke-WebRequest -Uri "$baseUrl/store/carts/$cartId/complete" -Method Post -Body $orderBody -ContentType "application/json" -UseBasicParsing -ErrorAction Stop
    $order = ($orderResp.Content | ConvertFrom-Json)
    
    if ($order.type -eq "order") {
        $orderId = $order.data.id
        Write-Host "  - Order placed successfully!" -ForegroundColor Green
        Write-Host ""

        Write-Host "============================================================" -ForegroundColor Green
        Write-Host "           ORDER PLACEMENT SUCCESSFUL!                     " -ForegroundColor Green
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host ""
        
        Write-Host "  Order ID: $orderId" -ForegroundColor White
        Write-Host "  Customer: test@example.com" -ForegroundColor White
        Write-Host "  Product: $($product.title)" -ForegroundColor White
        Write-Host "  Status: $($order.data.status)" -ForegroundColor White
        Write-Host ""
        Write-Host "  [SUCCESS] Definition of Done: ACHIEVED" -ForegroundColor Green
        Write-Host "  [SUCCESS] Store can process orders end-to-end" -ForegroundColor Green
        Write-Host ""
    } else {
        throw "Order completion returned unexpected response"
    }

} catch {
    Write-Host ""
    Write-Host "ERROR: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Note: Some MedusaJS configurations may require additional setup." -ForegroundColor Yellow
    Write-Host "If this fails, verify the store has:" -ForegroundColor Yellow
    Write-Host "  - Products with variants" -ForegroundColor Gray
    Write-Host "  - Shipping options configured" -ForegroundColor Gray
    Write-Host "  - Payment providers enabled" -ForegroundColor Gray
    Write-Host ""
    exit 1
}
